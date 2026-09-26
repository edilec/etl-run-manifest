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
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { record, reseal, runJson, ruleIds, runDescription, temporary, tree, write, writeRun } from './support.mjs'

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

/** Two complete runs whose descriptions differ only in what the caller overrides. */
function comparedRuns(t, overrideA, overrideB) {
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b)
  writeRun(a, runDescription({ runId: 'run-a', ...overrideA }))
  writeRun(b, runDescription({ runId: 'run-b', ...overrideB }))
  const first = record(a)
  const second = record(b)
  assert.equal(first.status, 0)
  assert.equal(second.status, 0)
  return runJson(['compare', '--baseline', first.manifestPath, '--candidate', second.manifestPath, '--quiet'])
}

const CODE = [{ path: 'sql/t.sql' }]

test('compare says WHICH transformation differs, rather than only withholding the verdict', (t) => {
  // Without the finding the run is exit 0 with an empty findings list: the
  // verdict is withheld, and nothing tells the consumer why.
  const byId = comparedRuns(t, {}, { transformation: { id: 'normalise-v2', version: '1.0.0', code: CODE } })
  assert.equal(byId.status, 1)
  assert.equal(byId.report.status, 'fail')
  assert.deepEqual(ruleIds(byId.report), ['transformation-differs'])
  assert.equal(byId.report.findings[0].location.pointer, '/run/transformation/id')
  assert.equal(byId.report.findings[0].message, 'the baseline ran "normalise" and the candidate ran "normalise-v2"')
  assert.ok(!ruleIds(byId.report).includes('runs-reproduced'))

  const byVersion = comparedRuns(t, {}, { transformation: { id: 'normalise', version: '2.0.0', code: CODE } })
  assert.equal(byVersion.status, 1)
  assert.deepEqual(ruleIds(byVersion.report), ['transformation-differs'])
  assert.equal(byVersion.report.findings[0].location.pointer, '/run/transformation/version')
  assert.equal(
    byVersion.report.findings[0].message,
    'the baseline ran version "1.0.0" and the candidate ran version "2.0.0"',
  )
})

test('compare says WHICH parameter differs, and on which side', (t) => {
  const extra = comparedRuns(t, {}, {
    parameters: [{ name: 'batch_size', value: 500 }, { name: 'currency', value: 'EUR' }],
  })
  assert.equal(extra.status, 1)
  assert.equal(extra.report.status, 'fail')
  assert.deepEqual(ruleIds(extra.report), ['parameters-differ'])
  assert.equal(extra.report.findings[0].location.file, '(candidate)')
  assert.equal(extra.report.findings[0].location.pointer, '/run/parameters/currency')
  assert.equal(extra.report.findings[0].message, 'the parameter "currency" is recorded by the candidate only')
  assert.ok(!ruleIds(extra.report).includes('runs-reproduced'))

  const changed = comparedRuns(t, {}, { parameters: [{ name: 'batch_size', value: 250 }] })
  assert.equal(changed.status, 1)
  assert.deepEqual(ruleIds(changed.report), ['parameters-differ'])
  assert.equal(
    changed.report.findings[0].message,
    'the parameter "batch_size" was 500 in the baseline and 250 in the candidate',
  )
})

test('differently named credentials are reported as lineage and do NOT withhold the verdict', (t) => {
  // Documented deliberately: a manifest pins the bytes of every input, so a run
  // that read the same bytes under a different credential name read the same
  // data. The difference is recorded, at info severity, and the comparison
  // still passes.
  const compared = comparedRuns(t, {}, { secretRefs: [{ name: 'WAREHOUSE_WRITER', source: 'vault' }] })
  assert.equal(compared.status, 0)
  assert.equal(compared.report.status, 'pass')
  assert.deepEqual(ruleIds(compared.report).sort(), ['runs-reproduced', 'secret-refs-differ'])
  const finding = compared.report.findings.find((entry) => entry.ruleId === 'secret-refs-differ')
  assert.equal(finding.severity, 'info')
  assert.equal(finding.location.pointer, '/run/secretRefs')
  assert.match(finding.message, /baseline: WAREHOUSE_READER@env; candidate: WAREHOUSE_WRITER@vault/)
  assert.match(finding.message, /does not enter the determinism verdict/)
})

test('a run naming no credential at all is compared against one that does', (t) => {
  const compared = comparedRuns(t, {}, { secretRefs: [] })
  assert.equal(compared.status, 0)
  const finding = compared.report.findings.find((entry) => entry.ruleId === 'secret-refs-differ')
  assert.match(finding.message, /baseline: WAREHOUSE_READER@env; candidate: none/)
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

test('an edited manifest reports the edit AND the integrity mismatch', (t) => {
  // This edit changes `seed`, which compare reads, so the verdict is withheld
  // for two independent reasons. What it pins is that both are reported: the
  // integrity mismatch alone is pinned by the test below, where the edited
  // field is one compare never looks at.
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

test('a manifest edited in a field compare never reads still yields no verdict', (t) => {
  const { a, b } = twoRuns(t)
  // `recordedAt` is an opaque label that compare does not read: every field the
  // verdict rests on is equal and known on both sides, and the ONLY thing
  // withholding `runs-reproduced` is that this manifest no longer matches the
  // digest it carries. A manifest somebody edited is not evidence, whichever
  // field they edited.
  const tampered = JSON.parse(readFileSync(a.manifestPath, 'utf8'))
  tampered.run.recordedAt = '2026-09-18T03:00:00Z'
  writeFileSync(a.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')

  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 1)
  assert.equal(compared.report.status, 'fail')
  assert.deepEqual(ruleIds(compared.report), ['manifest-integrity-mismatch'])
  assert.equal(compared.report.summary.differing, 0, 'nothing compare reads differs between these two manifests')
  assert.equal(compared.report.summary.unresolved, 0, 'every digest is present on both sides')
  assert.ok(
    !ruleIds(compared.report).includes('runs-reproduced'),
    'a tampered manifest cannot assert that two runs reproduced each other',
  )
  assert.ok(!ruleIds(compared.report).includes('output-nondeterministic'))
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
  assert.equal(
    compared.report.findings[0].message,
    'neither manifest recorded a digest for the input "refunds_raw" (baseline: not-found; candidate: not-found), '
    + 'so this pair cannot be compared; two absent digests are not a match',
  )
  assert.equal(compared.report.summary.unresolved, 1)
  // Every other file matched, and the verdict is still withheld.
  assert.ok(!ruleIds(compared.report).includes('runs-reproduced'))
  assert.ok(!ruleIds(compared.report).includes('output-nondeterministic'))
})

test('FLAGSHIP: a manifest that repeats a key is refused, never compared on one of its entries', (t) => {
  const { a, b } = twoRuns(t)
  // A second entry for a code file that could not be read, re-sealed so the
  // integrity digest is correct: the only thing wrong with this manifest is
  // that it records two entries under one key.
  reseal(a.manifestPath, (manifest) => {
    manifest.run.transformation.code.unshift({ bytes: null, digest: null, path: 'sql/t.sql', unresolved: 'not-found' })
  })

  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 2, 'an entry dropped while indexing makes the comparison incomplete, not clean')
  assert.equal(compared.report.status, 'incomplete')
  assert.deepEqual(ruleIds(compared.report), ['manifest-invalid'])
  assert.equal(compared.report.findings[0].location.pointer, '/run/transformation/code/1')
  assert.match(compared.report.findings[0].message, /repeats the code path "sql\/t\.sql"/)
  assert.ok(
    !ruleIds(compared.report).includes('runs-reproduced'),
    'the second entry has no digest, so nothing here supports a positive verdict',
  )
  // The same manifest is refused by verify, because both commands compile it
  // through one loader rather than each deciding for itself.
  const verified = runJson(['verify', '--root', dirname(a.manifestPath), '--manifest', a.manifestPath, '--quiet'])
  assert.equal(verified.status, 2)
  assert.deepEqual(ruleIds(verified.report), ['manifest-invalid'])
})

test('a repeated parameter name cannot hide a parameter divergence behind a reproduced verdict', (t) => {
  const { a, b } = twoRuns(t)
  // The baseline records currency=USD AND currency=EUR; the candidate records
  // only currency=EUR. Indexing by name would keep one of the two and report
  // the runs as having used the same parameters.
  reseal(a.manifestPath, (manifest) => {
    manifest.run.parameters = [{ name: 'currency', value: 'USD' }, { name: 'currency', value: 'EUR' }]
  })
  reseal(b.manifestPath, (manifest) => {
    manifest.run.parameters = [{ name: 'currency', value: 'EUR' }]
  })

  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 2)
  assert.equal(compared.report.status, 'incomplete')
  assert.deepEqual(ruleIds(compared.report), ['manifest-invalid'])
  assert.equal(compared.report.findings[0].location.pointer, '/run/parameters/1')
  assert.match(compared.report.findings[0].message, /repeats the parameter name "currency"/)
  assert.ok(!ruleIds(compared.report).includes('runs-reproduced'))
})

test('a manifest repeating a secret reference name or a parent run id is refused as well', (t) => {
  // `record` refuses these on the way in, so a manifest carrying one was not
  // written by this tool. The manifest schema says so rather than reading a
  // document its own writer could not have produced.
  const { a, b } = twoRuns(t)
  reseal(a.manifestPath, (manifest) => {
    manifest.run.secretRefs = [{ name: 'WAREHOUSE_READER', source: 'env' }, { name: 'WAREHOUSE_READER', source: 'vault' }]
    manifest.run.parentRunIds = ['extract-1', 'extract-1']
  })

  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 2)
  assert.equal(compared.report.status, 'incomplete')
  assert.deepEqual(ruleIds(compared.report), ['manifest-invalid', 'manifest-invalid'])
  assert.deepEqual(
    compared.report.findings.map((finding) => finding.location.pointer).sort(),
    ['/run/parentRunIds/1', '/run/secretRefs/1'],
  )
  assert.match(compared.report.findings[0].message, /repeats the parent run id "extract-1"/)
  assert.match(compared.report.findings[1].message, /repeats the secret reference name "WAREHOUSE_READER"/)
  assert.ok(!ruleIds(compared.report).includes('runs-reproduced'))
})

test('two parameters with DIFFERENT names are not a repeat: the legal case stays silent', (t) => {
  const { a, b } = twoRuns(t)
  const parameters = [{ name: 'batch_size', value: 500 }, { name: 'currency', value: 'EUR' }]
  reseal(a.manifestPath, (manifest) => { manifest.run.parameters = parameters })
  reseal(b.manifestPath, (manifest) => { manifest.run.parameters = parameters })

  const compared = runJson(['compare', '--baseline', a.manifestPath, '--candidate', b.manifestPath, '--quiet'])
  assert.equal(compared.status, 0)
  assert.deepEqual(ruleIds(compared.report), ['runs-reproduced'])
})

test('the unresolved message names the side that has NO digest, and why', (t) => {
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b)
  // The second input exists under b and not under a, so exactly one side of
  // the pair has a digest.
  write(b, 'data/refunds.csv', 'a,b\n1,2\n')
  const description = (runId) => runDescription({
    runId,
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'refunds_raw', path: 'data/refunds.csv' }],
  })
  writeRun(a, description('run-a'))
  writeRun(b, description('run-b'))
  const incomplete = record(a)
  const complete = record(b)
  assert.equal(incomplete.status, 2)
  assert.equal(complete.status, 0)

  // A reader sent to the wrong manifest is worse served than one told nothing:
  // the finding must name the side that is missing the evidence.
  const forward = runJson(['compare', '--baseline', incomplete.manifestPath, '--candidate', complete.manifestPath, '--quiet'])
  assert.equal(forward.status, 2)
  const first = forward.report.findings.find((finding) => finding.ruleId === 'evidence-unresolved')
  assert.equal(first.location.file, '(baseline)')
  assert.equal(
    first.message,
    'the baseline recorded no digest for the input "refunds_raw" (not-found), so this pair cannot be compared; '
    + 'the digest the other manifest holds has nothing to check against',
  )

  const reverse = runJson(['compare', '--baseline', complete.manifestPath, '--candidate', incomplete.manifestPath, '--quiet'])
  assert.equal(reverse.status, 2)
  const second = reverse.report.findings.find((finding) => finding.ruleId === 'evidence-unresolved')
  assert.equal(second.location.file, '(candidate)')
  assert.match(second.message, /^the candidate recorded no digest for the input "refunds_raw" \(not-found\)/)
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

test('an unresolved OUTPUT withholds the reproduced verdict, exactly as an input does', (t) => {
  // The verdict rests on three things being KNOWN: the code and inputs, and the
  // outputs. An output pair with no digest on either side is not a matching
  // output -- it is no evidence about the outputs at all -- so "these two runs
  // reproduced" cannot be said, however completely the inputs agree.
  const directory = temporary(t)
  const a = join(directory, 'a')
  const b = join(directory, 'b')
  tree(a)
  tree(b)
  const description = (runId) => runDescription({
    runId,
    outputs: [{ id: 'orders', path: 'out/orders.tsv' }, { id: 'ledger', path: 'out/ledger.tsv' }],
  })
  writeRun(a, description('run-a'))
  writeRun(b, description('run-b'))
  const first = record(a)
  const second = record(b)
  assert.equal(first.status, 2, 'the second output does not exist, so its digest is unresolved')
  assert.equal(second.status, 2)

  const compared = runJson(['compare', '--baseline', first.manifestPath, '--candidate', second.manifestPath, '--quiet'])
  assert.equal(compared.status, 2)
  assert.equal(compared.report.status, 'incomplete')
  assert.deepEqual(ruleIds(compared.report), ['evidence-unresolved'])
  assert.equal(compared.report.findings[0].location.pointer, '/run/outputs/ledger')
  assert.equal(compared.report.summary.unresolved, 1)
  assert.equal(compared.report.summary.differing, 0, 'every other file matched on both sides')
  assert.ok(
    !ruleIds(compared.report).includes('runs-reproduced'),
    'an output nobody could hash is not an output that matched',
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
