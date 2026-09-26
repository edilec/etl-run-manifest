/**
 * The canonical serialisation and the integrity digest.
 *
 * One function writes the manifest and the same function feeds the digest. Two
 * serialisers -- one that writes and one that digests -- is the "two functions
 * look at one value" shape that has produced defects elsewhere in this catalog:
 * the digest ends up covering a rendering nobody ever sees.
 */

import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_DEPTH, canonicalDocument, canonicalJson, digestText } from '../src/index.mjs'
import { record, runDescription, temporary, tree, writeRun } from './support.mjs'

test('object keys are ordered by code unit, not by insertion order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalJson({ a_b: 1, Z: 2, 'a-b': 3 }), '{"Z":2,"a-b":3,"a_b":1}')
})

test('the indented form carries the same ordering and the same content', () => {
  const value = { b: [1, { d: 4, c: 3 }], a: 'x' }
  assert.equal(canonicalJson(JSON.parse(canonicalDocument(value))), canonicalJson(value))
  assert.match(canonicalDocument(value), /^\{\n {2}"a": "x",\n/)
})

test('a non-finite number has no canonical form', () => {
  assert.throws(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), TypeError)
  assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError)
  assert.throws(() => canonicalJson({ a: undefined, b: () => 1 }), TypeError)
})

test('nesting past the depth bound throws rather than recursing', () => {
  let value = 'leaf'
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) value = { nested: value }
  assert.throws(() => canonicalJson(value), new RegExp(`deeper than ${MAX_DEPTH}`))
})

test('the digest covers exactly the document minus its integrity block', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  const recomputed = digestText(canonicalJson({ schema: manifest.schema, tool: manifest.tool, run: manifest.run }))
  assert.equal(recomputed, manifest.integrity.digest)
})

test('declaration order does not change the manifest or its digest', (t) => {
  const directory = temporary(t)
  tree(directory)
  const forward = runDescription({
    inputs: [{ id: 'a', path: 'data/orders.csv' }, { id: 'b', path: 'out/orders.tsv' }],
  })
  const reversed = runDescription({
    inputs: [{ id: 'b', path: 'out/orders.tsv' }, { id: 'a', path: 'data/orders.csv' }],
  })
  writeRun(directory, forward)
  const first = record(directory, { out: 'one.json' })
  writeRun(directory, reversed)
  const second = record(directory, { out: 'two.json' })
  assert.equal(first.status, 0)
  assert.equal(second.status, 0)
  assert.equal(readFileSync(second.manifestPath, 'utf8'), readFileSync(first.manifestPath, 'utf8'))
})

test('the written manifest ends in a newline and parses as JSON', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  const text = readFileSync(recorded.manifestPath, 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(typeof JSON.parse(text), 'object')
})
