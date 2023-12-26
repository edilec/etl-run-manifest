/**
 * One scenario per rule that marks a run incomplete, each pinning the EXIT CODE.
 *
 * Deleting a single `incomplete = true` elsewhere in this catalog turned exit 2
 * into exit 1 with the whole suite green, and where the accompanying finding is
 * not error severity that flag is the ONLY thing standing between the run and a
 * green exit 0. So each case below asserts the exit code, and the
 * warning-severity cases also assert that `errors` is zero -- which is what
 * makes the assertion depend on the flag and nothing else.
 */

import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { INCOMPLETE_RULES } from '../src/index.mjs'
import { record, runJson, ruleIds, runDescription, temporary, tree, write, writeRun } from './support.mjs'

function assertIncomplete(result, ruleId, { errorsExpected }) {
  assert.equal(result.report.status, 'incomplete', `${ruleId} must report incomplete`)
  assert.equal(result.status, 2, `${ruleId} must exit 2`)
  assert.ok(ruleIds(result.report).includes(ruleId), `${ruleId} was not raised`)
  if (!errorsExpected) {
    assert.equal(result.report.summary.errors, 0, `${ruleId}: the incomplete flag is the only thing preventing exit 0`)
  }
}

test('run-description-unreadable', (t) => {
  const directory = temporary(t)
  tree(directory)
  assertIncomplete(record(directory), 'run-description-unreadable', { errorsExpected: true })
})

test('run-description-invalid', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({ seed: [] }))
  assertIncomplete(record(directory), 'run-description-invalid', { errorsExpected: true })
})

test('file-unreadable (warning only: the flag is the whole guard)', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({ inputs: [{ id: 'gone', path: 'data/gone.csv' }] }))
  assertIncomplete(record(directory), 'file-unreadable', { errorsExpected: false })
})

test('file-too-large (warning only: the flag is the whole guard)', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  assertIncomplete(record(directory, { args: ['--max-file-bytes', '1'] }), 'file-too-large', { errorsExpected: false })
})

test('path-outside-root', (t) => {
  const directory = temporary(t)
  const root = join(directory, 'root')
  tree(root)
  writeFileSync(join(directory, 'elsewhere.csv'), 'secret-ish\n', 'utf8')
  symlinkSync(join(directory, 'elsewhere.csv'), join(root, 'data/escape.csv'))
  writeRun(root, runDescription({ inputs: [{ id: 'escape', path: 'data/escape.csv' }] }))
  const recorded = record(root)
  assertIncomplete(recorded, 'path-outside-root', { errorsExpected: true })
  assert.ok(!recorded.stdout.includes('secret-ish'), 'out-of-root content is never echoed')
})

test('no-evidence-recorded', (t) => {
  const directory = temporary(t)
  writeRun(directory, runDescription({
    transformation: { id: 'n', version: '1', code: [] },
    inputs: [],
    outputs: [],
  }))
  assertIncomplete(record(directory), 'no-evidence-recorded', { errorsExpected: true })
})

test('finding-limit-reached (warning only: the flag is the whole guard)', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: Array.from({ length: 4 }, (unused, index) => ({ id: `in-${index}`, path: `data/gone-${index}.csv` })),
  }))
  assertIncomplete(record(directory, { args: ['--max-findings', '2'] }), 'finding-limit-reached', { errorsExpected: false })
})

test('manifest-unreadable', (t) => {
  const directory = temporary(t)
  tree(directory)
  const verified = runJson(['verify', '--root', directory, '--manifest', join(directory, 'nope.json'), '--quiet'])
  assertIncomplete(verified, 'manifest-unreadable', { errorsExpected: true })
})

test('manifest-invalid', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  manifest.run.inputs[0].digest = 'not-a-digest'
  writeFileSync(recorded.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assertIncomplete(verified, 'manifest-invalid', { errorsExpected: true })
})

test('digest-unresolved (warning only: the flag is the whole guard)', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'gone', path: 'data/gone.csv' }],
  }))
  const recorded = record(directory)
  write(directory, 'data/gone.csv', 'a,b\n1,2\n')
  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assertIncomplete(verified, 'digest-unresolved', { errorsExpected: false })
})

test('evidence-unresolved (warning only: the flag is the whole guard)', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'gone', path: 'data/gone.csv' }],
  }))
  const recorded = record(directory)
  const compared = runJson([
    'compare', '--baseline', recorded.manifestPath, '--candidate', recorded.manifestPath, '--quiet',
  ])
  assertIncomplete(compared, 'evidence-unresolved', { errorsExpected: false })
  assert.ok(!ruleIds(compared.report).includes('runs-reproduced'), 'a manifest compared with itself is still not a match')
})

test('every rule in INCOMPLETE_RULES has a scenario above', () => {
  assert.deepEqual([...INCOMPLETE_RULES].sort(), [
    'digest-unresolved', 'evidence-unresolved', 'file-too-large', 'file-unreadable', 'finding-limit-reached',
    'manifest-invalid', 'manifest-unreadable', 'no-evidence-recorded', 'path-outside-root',
    'run-description-invalid', 'run-description-unreadable',
  ])
})
