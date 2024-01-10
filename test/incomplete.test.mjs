/**
 * One scenario per rule that marks a run incomplete, each pinning the EXIT CODE.
 *
 * Deleting a single `incomplete = true` elsewhere in this catalog turned exit 2
 * into exit 1 with the whole suite green, and where the accompanying finding is
 * not error severity that flag is the ONLY thing standing between the run and a
 * green exit 0. So each case below asserts the exit code, and the
 * warning-severity cases also assert that `errors` is zero -- which is what
 * makes the assertion depend on the flag and nothing else.
 *
 * Several rules are reachable from more than one command, and a scenario for
 * one of them says nothing about the other: `record` and `verify` each decide
 * separately what to do with a file they could not read. The verify-side
 * scenarios are at the end of this file.
 */

import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/**
 * The verify side of an entry that has a digest and a file that cannot be
 * re-hashed.
 *
 * `verify` counts the entry as unresolved and reports why. The count alone
 * suppresses `verification-complete`, so a missing report leaves status "pass",
 * exit 0 and an EMPTY findings list for a manifest whose recorded input is
 * gone -- a green run over evidence nobody could obtain. Each case below pins
 * the rule id as well as the exit code, so the mapping from reason to rule is
 * pinned too.
 */
function verifyUnresolved(t, { orders, args = [], after = () => {}, unresolved = 1 } = {}) {
  const directory = temporary(t)
  // The tree sits in a subdirectory so that "outside the root" has somewhere to be.
  const root = join(directory, 'root')
  tree(root, orders === undefined ? {} : { orders })
  writeRun(root)
  const recorded = record(root)
  assert.equal(recorded.status, 0, 'the manifest under test must start out complete')
  after(root, directory)
  const verified = runJson(['verify', '--root', root, '--manifest', recorded.manifestPath, '--quiet', ...args])
  assert.ok(
    !ruleIds(verified.report).includes('verification-complete'),
    'a file that could not be re-read is not a verification',
  )
  assert.equal(verified.report.summary.unresolved, unresolved)
  assert.equal(verified.report.summary.mismatched, 0)
  return verified
}

test('file-unreadable via verify: a recorded input that has vanished', (t) => {
  const verified = verifyUnresolved(t, { after: (root) => rmSync(join(root, 'data/orders.csv')) })
  assertIncomplete(verified, 'file-unreadable', { errorsExpected: false })
  assert.deepEqual(ruleIds(verified.report), ['file-unreadable'])
  const finding = verified.report.findings[0]
  assert.equal(finding.location.file, 'data/orders.csv')
  assert.equal(finding.location.pointer, '/run/inputs/0')
  assert.match(finding.message, /could not be resolved \(ENOENT\), so the digest the manifest records for it could not be checked/)
  assert.equal(verified.report.summary.verified, 2, 'the other two files were still checked')
})

test('file-too-large via verify: a recorded file over the bound is not re-hashed', (t) => {
  // Only the input is over the bound; the other two files are still verified,
  // so the report distinguishes "not checked" from "checked and fine".
  const verified = verifyUnresolved(t, { orders: `a,b\n${'1,2\n'.repeat(10)}`, args: ['--max-file-bytes', '20'] })
  assertIncomplete(verified, 'file-too-large', { errorsExpected: false })
  assert.deepEqual(ruleIds(verified.report), ['file-too-large'])
  assert.match(verified.report.findings[0].message, /is 44 bytes, over the file limit of 20/)
  assert.equal(verified.report.summary.verified, 2)
})

test('path-outside-root via verify: a recorded path that now leaves the root', (t) => {
  const verified = verifyUnresolved(t, {
    after: (root, directory) => {
      writeFileSync(join(directory, 'elsewhere.csv'), 'not-in-the-root\n', 'utf8')
      rmSync(join(root, 'data/orders.csv'))
      symlinkSync(join(directory, 'elsewhere.csv'), join(root, 'data/orders.csv'))
    },
  })
  assertIncomplete(verified, 'path-outside-root', { errorsExpected: true })
  assert.deepEqual(ruleIds(verified.report), ['path-outside-root'])
  assert.match(verified.report.findings[0].message, /resolves outside the declared root/)
  assert.ok(!verified.stdout.includes('not-in-the-root'), 'out-of-root content is never echoed')
})
