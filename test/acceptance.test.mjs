/**
 * The acceptance criteria, item by item:
 *
 *   "Changing an input invalidates its evidence"
 *   "repeated deterministic transformations can be compared"
 *   "credentials are excluded"
 *
 * The good case is first, deliberately. A finding raised on correct input is
 * the worst defect a checker can have: a miss leaves you where you were, a
 * false positive sends somebody to fix what was already right.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { record, runJson, ruleIds, runDescription, temporary, tree, write, writeRun } from './support.mjs'

test('THE GOOD CASE: a complete, readable run records and verifies with nothing to report', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)

  const recorded = record(directory)
  assert.equal(recorded.status, 0)
  assert.equal(recorded.report.status, 'pass')
  assert.equal(recorded.report.summary.errors, 0)
  assert.equal(recorded.report.summary.warnings, 0)
  assert.deepEqual(ruleIds(recorded.report), ['manifest-recorded'])
  assert.equal(recorded.report.summary.checked, 3)
  assert.equal(recorded.report.summary.unresolved, 0)

  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.equal(verified.status, 0)
  assert.equal(verified.report.status, 'pass')
  assert.deepEqual(ruleIds(verified.report), ['verification-complete'])
  assert.equal(verified.report.summary.verified, 3)
  assert.equal(verified.report.summary.mismatched, 0)
})

test('ACCEPTANCE: changing an input invalidates the evidence recorded about it', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  assert.equal(recorded.status, 0)

  writeFileSync(join(directory, 'data/orders.csv'), 'a,b\n1,3\n', 'utf8')

  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.equal(verified.status, 1, 'a changed input is a completed check whose policy failed')
  assert.equal(verified.report.status, 'fail')
  assert.deepEqual(ruleIds(verified.report), ['input-digest-mismatch'])
  const finding = verified.report.findings[0]
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'data/orders.csv')
  assert.equal(finding.location.pointer, '/run/inputs/0')
  assert.match(finding.message, /no longer valid/)
  assert.equal(verified.report.summary.verified, 2)
  assert.equal(verified.report.summary.mismatched, 1)
  assert.equal(verified.report.summary.unresolved, 0)
})

test('ACCEPTANCE: changing an output or a code file invalidates its evidence too', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)

  writeFileSync(join(directory, 'out/orders.tsv'), 'a\tb\n9\t9\n', 'utf8')
  writeFileSync(join(directory, 'sql/t.sql'), 'SELECT 2;\n', 'utf8')

  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.equal(verified.status, 1)
  assert.deepEqual(ruleIds(verified.report).sort(), ['code-digest-mismatch', 'output-digest-mismatch'])
  assert.equal(verified.report.summary.mismatched, 2)
})

test('ACCEPTANCE: editing the manifest itself invalidates it, digests or no digests', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)

  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  manifest.run.parameters[0].value = 501
  writeFileSync(recorded.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.equal(verified.status, 1)
  assert.equal(verified.report.status, 'fail')
  assert.ok(ruleIds(verified.report).includes('manifest-integrity-mismatch'))
  // Every file still hashes correctly; the failure is the manifest, not the data.
  assert.equal(verified.report.summary.mismatched, 0)
  assert.equal(verified.report.summary.verified, 3)
  // And the tool does NOT then claim the verification completed.
  assert.ok(!ruleIds(verified.report).includes('verification-complete'))
})

function twoRuns(t, { outputB = 'a\tb\n1\t2\n', inputB = 'a,b\n1,2\n' } = {}) {
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b, { orders: inputB, output: outputB })
  writeRun(a, runDescription({ runId: 'run-a' }))
  writeRun(b, runDescription({ runId: 'run-b' }))
  return { a: record(a), b: record(b) }
}

test('ACCEPTANCE: two runs of one deterministic transformation compare as reproduced', (t) => {
  const { a, b } = twoRuns(t)
  assert.equal(a.status, 0)
  assert.equal(b.status, 0)
  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 0)
  assert.equal(compared.report.status, 'pass')
  assert.deepEqual(ruleIds(compared.report), ['runs-reproduced'])
  assert.equal(compared.report.summary.differing, 0)
  assert.equal(compared.report.summary.unresolved, 0)
  assert.ok(compared.report.summary.checked > 0, 'a comparison of nothing is not a pass')
})

test('ACCEPTANCE: identical inputs with differing outputs is reported as nondeterminism', (t) => {
  const { a, b } = twoRuns(t, { outputB: 'a\tb\n2\t1\n' })
  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 1)
  assert.equal(compared.report.status, 'fail')
  assert.deepEqual(ruleIds(compared.report).sort(), ['output-nondeterministic', 'outputs-differ'])
  assert.equal(compared.report.summary.differing, 1)
})

test('differing inputs are reported as differing inputs, never as nondeterminism', (t) => {
  const { a, b } = twoRuns(t, { inputB: 'a,b\n4,4\n', outputB: 'a\tb\n4\t4\n' })
  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 1)
  assert.deepEqual(ruleIds(compared.report).sort(), ['inputs-differ', 'outputs-differ'])
  assert.ok(
    !ruleIds(compared.report).includes('output-nondeterministic'),
    'outputs differing while inputs differ is not evidence about determinism',
  )
})

test('ACCEPTANCE: the run description has no field for a credential value, so one cannot be recorded', (t) => {
  const directory = temporary(t)
  tree(directory)
  const description = runDescription()
  description.secretRefs = [{ name: 'WAREHOUSE_READER', source: 'env', value: 'not-a-real-secret-0000' }]
  writeRun(directory, description)

  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.status, 'incomplete')
  // Pin what IS there beside what is not: an absence assertion alone passes for
  // every path that produces nothing, including the wrong ones.
  assert.deepEqual(ruleIds(recorded.report), ['run-description-invalid'])
  assert.equal(recorded.report.findings[0].location.pointer, '/secretRefs/0/value')
  assert.match(recorded.report.findings[0].message, /is not a key this schema defines/)
  assert.ok(!recorded.stdout.includes('not-a-real-secret-0000'))
  assert.ok(!recorded.stderr.includes('not-a-real-secret-0000'))
})

test('ACCEPTANCE: a key the schema does not name is refused, so a credential beside a parameter never travels', (t) => {
  const directory = temporary(t)
  tree(directory)
  const description = runDescription()
  description.password = 'not-a-real-secret-1111'
  writeRun(directory, description)

  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.deepEqual(ruleIds(recorded.report), ['run-description-invalid'])
  assert.equal(recorded.report.findings[0].location.pointer, '/password')
  assert.ok(!recorded.stdout.includes('not-a-real-secret-1111'))
})

test('ACCEPTANCE: a credential is recorded by name and source only, and the environment is never read', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)

  // The run description says the run used the credential in WAREHOUSE_READER.
  // A variable of exactly that name is set for the child process, holding an
  // obviously invented value. The tool reads no environment, so it is not
  // consulted, and there is nothing for it to record.
  const withValue = record(directory, { env: { WAREHOUSE_READER: 'not-a-real-secret-7777' } })
  assert.equal(withValue.status, 0)
  const manifestText = readFileSync(withValue.manifestPath, 'utf8')

  // What IS there, beside what is not.
  const manifest = JSON.parse(manifestText)
  assert.deepEqual(manifest.run.secretRefs, [{ name: 'WAREHOUSE_READER', source: 'env' }])
  assert.deepEqual(Object.keys(manifest.run.secretRefs[0]).sort(), ['name', 'source'])
  assert.equal(manifest.run.runId, 'run-1')
  assert.ok(!manifestText.includes('not-a-real-secret-7777'))
  assert.ok(!withValue.stdout.includes('not-a-real-secret-7777'))
  assert.ok(!withValue.stderr.includes('not-a-real-secret-7777'))

  // And the value makes no difference at all: the same run with a different
  // value in that variable records byte-identical bytes.
  const withOther = record(directory, {
    out: 'manifest-2.json',
    env: { WAREHOUSE_READER: 'not-a-real-secret-8888' },
  })
  assert.equal(withOther.status, 0)
  assert.equal(readFileSync(withOther.manifestPath, 'utf8'), manifestText)
})

test('a parameter value that is an object is refused, and is never stringified on the way to the message', (t) => {
  const directory = temporary(t)
  tree(directory)
  const description = runDescription()
  description.parameters = [{ name: 'connection', value: { toString: {} } }]
  writeRun(directory, description)

  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.deepEqual(ruleIds(recorded.report), ['run-description-invalid'])
  assert.equal(recorded.report.findings[0].location.pointer, '/parameters/0/value')
  assert.match(recorded.report.findings[0].message, /not object/)
  assert.match(recorded.report.findings[0].message, /secretRefs/)
})

test('a manifest is written for an unreadable file, marked, and the run still exits 2', (t) => {
  const directory = temporary(t)
  tree(directory)
  const description = runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'refunds_raw', path: 'data/refunds.csv' }],
  })
  writeRun(directory, description)

  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.status, 'incomplete')
  assert.deepEqual(ruleIds(recorded.report).sort(), ['file-unreadable', 'manifest-recorded'])

  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  const refunds = manifest.run.inputs.find((entry) => entry.id === 'refunds_raw')
  // The entry is present and says why it has no digest. A gap would read as
  // "this run had no such input", which is a different and false claim.
  assert.ok(refunds !== undefined, 'an input that could not be hashed is still recorded')
  assert.equal(refunds.digest, null)
  assert.equal(refunds.unresolved, 'not-found')
})

test('a manifest that fails its own integrity digest yields no comparison verdict', (t) => {
  const { a, b } = twoRuns(t)
  const tampered = JSON.parse(readFileSync(a.manifestPath, 'utf8'))
  tampered.run.seed = 99
  writeFileSync(a.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')

  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 1)
  assert.equal(compared.report.status, 'fail')
  assert.ok(ruleIds(compared.report).includes('manifest-integrity-mismatch'))
  assert.ok(
    !ruleIds(compared.report).includes('runs-reproduced'),
    'a manifest somebody edited is not evidence that two runs reproduced each other',
  )
  assert.ok(!ruleIds(compared.report).includes('output-nondeterministic'))
  // The seed difference the edit introduced is still reported, so the reader
  // can see what changed as well as that the evidence is untrustworthy.
  assert.ok(ruleIds(compared.report).includes('seed-differs'))
})

test('FLAGSHIP: two absent digests are not a match, on either side of the comparison', (t) => {
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b)
  const description = (runId) => runDescription({
    runId,
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'refunds_raw', path: 'data/refunds.csv' }],
  })
  writeRun(a, description('run-a'))
  writeRun(b, description('run-b'))
  const first = record(a)
  const second = record(b)
  assert.equal(first.status, 2)
  assert.equal(second.status, 2)

  const compared = runJson(['compare', '--baseline', first.manifestPath, '--candidate', second.manifestPath, '--quiet'])
  assert.equal(compared.status, 2, 'null === null is true in JavaScript and false about the world')
  assert.equal(compared.report.status, 'incomplete')
  assert.deepEqual(ruleIds(compared.report), ['evidence-unresolved'])
  assert.equal(compared.report.findings[0].location.pointer, '/run/inputs/refunds_raw')
  assert.match(compared.report.findings[0].message, /two absent digests are not a match/)
  assert.equal(compared.report.summary.unresolved, 1)
  // Every other file matched, and the verdict is still withheld.
  assert.ok(!ruleIds(compared.report).includes('runs-reproduced'))
  assert.ok(!ruleIds(compared.report).includes('output-nondeterministic'))
})

test('an unresolved input withholds the nondeterminism verdict even when the outputs differ', (t) => {
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b, { output: 'a\tb\n7\t7\n' })
  const description = (runId) => runDescription({
    runId,
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'refunds_raw', path: 'data/refunds.csv' }],
  })
  writeRun(a, description('run-a'))
  writeRun(b, description('run-b'))
  const compared = runJson([
    'compare', '--baseline', record(a).manifestPath, '--candidate', record(b).manifestPath, '--quiet',
  ])
  assert.equal(compared.status, 2)
  assert.equal(compared.report.status, 'incomplete')
  assert.ok(ruleIds(compared.report).includes('outputs-differ'))
  assert.ok(
    !ruleIds(compared.report).includes('output-nondeterministic'),
    'outputs differing while an input is unknown is evidence of nothing',
  )
})

test('verifying an entry the manifest never hashed is not a verification', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'refunds_raw', path: 'data/refunds.csv' }],
  }))
  const recorded = record(directory)
  // The file now exists, and the manifest still records no digest for it.
  write(directory, 'data/refunds.csv', 'a,b\n1,2\n')

  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.equal(verified.status, 2)
  assert.equal(verified.report.status, 'incomplete')
  assert.deepEqual(ruleIds(verified.report), ['digest-unresolved'])
  assert.equal(verified.report.summary.unresolved, 1)
  assert.equal(verified.report.summary.verified, 3)
  assert.ok(!ruleIds(verified.report).includes('verification-complete'))
})

test('a run description naming no file at all is not a green run', (t) => {
  const directory = temporary(t)
  writeRun(directory, runDescription({
    transformation: { id: 'normalise', version: '1.0.0', code: [] },
    inputs: [],
    outputs: [],
  }))
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.status, 'incomplete')
  assert.ok(ruleIds(recorded.report).includes('no-evidence-recorded'))
  assert.equal(recorded.report.summary.checked, 0)
})
