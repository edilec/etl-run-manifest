/**
 * Severity, pinned BEHAVIOURALLY.
 *
 * A frozen table asserted against a hand-written expected map in the tests is
 * defended by declarations agreeing with each other, and a coordinated edit of
 * all of them passes: one tool had 40 of 52 error rules survive exactly that
 * flip. Severity is not a label, it is the exit code -- so each class is driven
 * through the real CLI and the observable outcome is asserted.
 *
 * Flipping any error rule in the table to warning or info turns one of these
 * exit 1 assertions into exit 0.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { RULE_SEVERITY, severityOf } from '../src/index.mjs'
import { record, runJson, ruleIds, runDescription, temporary, tree, writeRun } from './support.mjs'

test('an info-only report is status pass and exit 0', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  assert.deepEqual(recorded.report.findings.map((finding) => finding.severity), ['info'])
  assert.equal(recorded.report.status, 'pass')
  assert.equal(recorded.status, 0)
})

test('an error finding with no missing evidence is status fail and exit 1', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  writeFileSync(join(directory, 'data/orders.csv'), 'a,b\n9,9\n', 'utf8')
  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.deepEqual(verified.report.findings.map((finding) => finding.severity), ['error'])
  assert.equal(verified.report.status, 'fail')
  assert.equal(verified.status, 1, 'input-digest-mismatch must be an error, which is an exit code')
})

test('a warning finding with missing evidence is status incomplete and exit 2', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'gone', path: 'data/gone.csv' }],
  }))
  const recorded = record(directory)
  assert.equal(recorded.report.summary.errors, 0, 'nothing here is an error')
  assert.equal(recorded.report.summary.warnings, 1)
  assert.equal(recorded.report.status, 'incomplete')
  assert.equal(recorded.status, 2, 'the incomplete flag is the only thing preventing exit 0 here')
})

test('incomplete outranks fail: a run with both exits 2', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'gone', path: 'data/gone.csv' }],
  }))
  const recorded = record(directory)
  writeFileSync(join(directory, 'data/orders.csv'), 'a,b\n9,9\n', 'utf8')
  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.ok(ruleIds(verified.report).includes('input-digest-mismatch'))
  assert.ok(ruleIds(verified.report).includes('digest-unresolved'))
  assert.equal(verified.report.summary.errors, 1)
  assert.equal(verified.report.status, 'incomplete')
  assert.equal(verified.status, 2)
})

test('every emitted finding takes its severity from the frozen table', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'gone', path: 'data/gone.csv' }],
  }))
  const recorded = record(directory)
  for (const finding of recorded.report.findings) {
    assert.equal(finding.severity, severityOf(finding.ruleId))
  }
})

test('an unknown rule id throws rather than defaulting to a severity', () => {
  assert.throws(() => severityOf('no-such-rule'), /unknown ruleId/)
})

test('the README rule table and the frozen table agree in BOTH directions', () => {
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')
  const documented = new Map()
  for (const line of readme.split('\n')) {
    const match = /^\| `([a-z-]+)` \| (error|warning|info) \| /.exec(line)
    if (match !== null) documented.set(match[1], match[2])
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(RULE_SEVERITY).sort())
  for (const [ruleId, severity] of documented) assert.equal(severity, RULE_SEVERITY[ruleId], ruleId)
})

test('the rule table is frozen', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})
