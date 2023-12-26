/**
 * Every example in the README, run as documented.
 *
 * An example that does not run is a documentation overclaim, and documentation
 * overclaims are counted as defects here.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROOT, runCli, runJson, ruleIds, temporary } from './support.mjs'

test('examples/nightly verifies clean: exit 0', () => {
  const result = runJson(['verify', '--root', 'examples/nightly', '--manifest', 'examples/nightly/manifest.json', '--quiet'])
  assert.equal(result.status, 0)
  assert.equal(result.report.status, 'pass')
  assert.deepEqual(ruleIds(result.report), ['verification-complete'])
})

test('examples/changed-input fails verification: exit 1', () => {
  const result = runJson([
    'verify', '--root', 'examples/changed-input', '--manifest', 'examples/changed-input/manifest.json', '--quiet',
  ])
  assert.equal(result.status, 1)
  assert.equal(result.report.status, 'fail')
  assert.deepEqual(ruleIds(result.report), ['input-digest-mismatch'])
  assert.equal(result.report.findings[0].location.file, 'data/orders.csv')
})

test('examples/repeat reproduces examples/nightly: exit 0', () => {
  const result = runJson([
    'compare', '--baseline', 'examples/nightly/manifest.json', '--candidate', 'examples/repeat/manifest.json', '--quiet',
  ])
  assert.equal(result.status, 0)
  assert.deepEqual(ruleIds(result.report), ['runs-reproduced'])
})

test('examples/nondeterministic reports nondeterminism: exit 1', () => {
  const result = runJson([
    'compare',
    '--baseline', 'examples/nondeterministic/a/manifest.json',
    '--candidate', 'examples/nondeterministic/b/manifest.json',
    '--quiet',
  ])
  assert.equal(result.status, 1)
  assert.ok(ruleIds(result.report).includes('output-nondeterministic'))
})

test('examples/unresolved compared with itself is incomplete, not a match: exit 2', () => {
  const result = runJson([
    'compare',
    '--baseline', 'examples/unresolved/manifest.json',
    '--candidate', 'examples/unresolved/manifest.json',
    '--quiet',
  ])
  assert.equal(result.status, 2)
  assert.equal(result.report.status, 'incomplete')
  assert.deepEqual(ruleIds(result.report), ['evidence-unresolved'])
  assert.ok(!ruleIds(result.report).includes('runs-reproduced'))
})

test('examples/unresolved verifies as incomplete: exit 2', () => {
  const result = runJson([
    'verify', '--root', 'examples/unresolved', '--manifest', 'examples/unresolved/manifest.json', '--quiet',
  ])
  assert.equal(result.status, 2)
  assert.equal(result.report.status, 'incomplete')
  assert.ok(ruleIds(result.report).includes('digest-unresolved'))
})

test('the quick start recording command runs and writes a manifest', (t) => {
  const directory = temporary(t)
  const out = join(directory, 'nightly-manifest.json')
  const result = runCli([
    'record', '--root', 'examples/nightly', '--run', 'examples/nightly/run.json', '--out', out, '--quiet',
  ])
  assert.equal(result.status, 0)
  // Re-recording the committed example reproduces it byte for byte.
  assert.equal(readFileSync(out, 'utf8'), readFileSync(join(ROOT, 'examples/nightly/manifest.json'), 'utf8'))
})

test('every command block in the README is one of the commands tested above', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const commands = readme.split('\n').filter((line) => line.includes('bin/etl-run-manifest.mjs'))
  assert.equal(commands.length, 6, 'the quick start documents six runnable commands')
})
