/**
 * Ordering, pinned behaviourally.
 *
 * A source grep for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text, so the grep passes while ordering silently becomes machine-dependent.
 *
 * These inputs are chosen so that code-unit order and collation order genuinely
 * disagree -- `Z` before `a`, `a-b` before `a_b`, `README` before `assets` --
 * and they are driven through the real report path. Substituting a collator for
 * `byCodeUnit` makes these fail.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { byCodeUnit } from '../src/index.mjs'
import { record, runJson, runDescription, temporary, tree, writeRun } from './support.mjs'

const NAMES = ['a_b.csv', 'Z.csv', 'assets.csv', 'a-b.csv', 'README', 'a.csv']
// Code unit: R(0x52) Z(0x5A) then a followed by -(0x2D) .(0x2E) _(0x5F) s(0x73).
const BY_CODE_UNIT = ['README', 'Z.csv', 'a-b.csv', 'a.csv', 'a_b.csv', 'assets.csv']

test('findings are ordered by code unit, which is not the collated order', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: NAMES.map((name, index) => ({ id: `in-${index}`, path: name })),
  }))
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  const files = recorded.report.findings
    .filter((finding) => finding.ruleId === 'file-unreadable')
    .map((finding) => finding.location.file)
  assert.deepEqual(files, BY_CODE_UNIT)
  assert.notDeepEqual(files, [...NAMES].sort((left, right) => left.localeCompare(right)))
})

test('compare orders its pairs by code unit too', (t) => {
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b)
  writeRun(a, runDescription({
    runId: 'run-a',
    inputs: NAMES.map((name) => ({ id: name, path: 'data/orders.csv' })),
  }))
  // The candidate declares none of those ids, so every pair is reported once.
  writeRun(b, runDescription({ runId: 'run-b' }))
  const compared = runJson([
    'compare', '--baseline', record(a).manifestPath, '--candidate', record(b).manifestPath, '--quiet',
  ])
  const pointers = compared.report.findings
    .filter((finding) => finding.ruleId === 'inputs-differ' && finding.location.pointer.startsWith('/run/inputs/'))
    .map((finding) => finding.location.pointer.replace('/run/inputs/', ''))
  assert.deepEqual(
    pointers.filter((name) => NAMES.includes(name)),
    BY_CODE_UNIT,
  )
})

test('manifest entries are recorded in code-unit order, whatever order they were declared in', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [
      { id: 'a_b', path: 'data/orders.csv' },
      { id: 'Z', path: 'data/orders.csv' },
      { id: 'a-b', path: 'data/orders.csv' },
    ],
  }))
  const recorded = record(directory)
  assert.equal(recorded.status, 0)
  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  assert.deepEqual(manifest.run.inputs.map((entry) => entry.id), ['Z', 'a-b', 'a_b'])
})

test('byCodeUnit itself disagrees with a collator on exactly these values', () => {
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a-b', 'a_b'), -1)
  assert.equal(byCodeUnit('README', 'assets'), -1)
  assert.equal('Z'.localeCompare('a') < 0, false, 'collation would put Z after a')
})
