/**
 * Every refusal the two schemas can make, by pointer and by message.
 *
 * A mutation sweep found fifteen `problems.add` calls in src/schema.mjs that
 * could be deleted with the whole suite green. None of them was unreachable:
 * each is the refusal for one malformed shape, and the document was simply
 * never driven through. Several are worse than uncovered -- deleting them
 * leaves the field `null` and the document VALID, so a run description whose
 * runId is a number would have recorded a manifest with no run id at all.
 *
 * The compile functions are called directly here because the message and the
 * pointer are the thing under test, and a table of malformed documents through
 * the CLI would be 30 process spawns for the same assertions. The last two
 * tests drive one of each kind through the real CLI, so the pointer and the
 * message are pinned where a consumer actually reads them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { compileManifest, compileRunDescription } from '../src/index.mjs'
import { record, ruleIds, runDescription, runJson, temporary, tree, write, writeRun } from './support.mjs'

function runDoc(overrides) {
  return { ...runDescription(), ...overrides }
}

const RUN_REFUSALS = [
  ['a runId that is a number', runDoc({ runId: 42 }), '/runId', 'must be a string, not number'],
  ['a runId that is empty', runDoc({ runId: '' }), '/runId', 'must not be empty'],
  ['a runId that is null', runDoc({ runId: null }), '/runId', 'must be a string, not null'],
  ['a transformation that is a string', runDoc({ transformation: 'normalise' }), '/transformation',
    'must be an object, not string'],
  ['inputs that are an object', runDoc({ inputs: {} }), '/inputs', 'must be an array, not object'],
  ['a code list that is a string', runDoc({ transformation: { id: 'n', version: '1', code: 'sql/t.sql' } }),
    '/transformation/code', 'must be an array, not string'],
  ['the wrong schema', runDoc({ schema: 'edilec.etl-run/v2' }), '/schema',
    'must be "edilec.etl-run/v1"; this document declares "edilec.etl-run/v2"'],
  ['a seed that is not a safe integer', runDoc({ seed: 12345678901234567890 }), '/seed',
    'must be a safe integer when it is a number'],
  ['a secret source this schema does not name', runDoc({ secretRefs: [{ name: 'CRED', source: 'aws' }] }),
    '/secretRefs/0/source',
    'must be one of env, file, keychain, parameter-store, vault, other; this schema has no field for a credential value'],
  ['a parameter value that is an array', runDoc({ parameters: [{ name: 'p', value: [] }] }), '/parameters/0/value',
    'must be a string, number, boolean or null, not array (a credential belongs in secretRefs, which records a name and never a value)'],
  ['an absolute path', runDoc({ inputs: [{ id: 'i', path: '/etc/hosts' }] }), '/inputs/0/path',
    'must be relative to the declared root, and this path is absolute'],
  ['a path with a .. segment', runDoc({ inputs: [{ id: 'i', path: 'data/../../secrets.csv' }] }), '/inputs/0/path',
    'must not contain an empty, "." or ".." segment'],
  ['a repeated dataset id', runDoc({
    inputs: [{ id: 'orders_raw', path: 'data/a.csv' }, { id: 'orders_raw', path: 'data/b.csv' }],
  }), '/inputs/1', 'repeats the dataset id "orders_raw"'],
]

for (const [label, document, pointer, message] of RUN_REFUSALS) {
  test(`a run description with ${label} is refused, with its pointer and its reason`, () => {
    const compiled = compileRunDescription(document)
    assert.equal(compiled.ok, false, `${label} was accepted`)
    const problem = compiled.problems.find((entry) => entry.pointer === pointer)
    assert.ok(problem !== undefined, `no problem at ${pointer}: ${JSON.stringify(compiled.problems)}`)
    assert.equal(problem.message, message)
  })
}

test('a parameter value that is a non-finite number is refused', () => {
  // JSON cannot carry Infinity, so this shape only reaches the schema through
  // the library entry point -- which is an entry point, and is refused there.
  const compiled = compileRunDescription(runDoc({ parameters: [{ name: 'ratio', value: Number.POSITIVE_INFINITY }] }))
  assert.equal(compiled.ok, false)
  assert.deepEqual(compiled.problems, [{ pointer: '/parameters/0/value', message: 'must be a finite number' }])
})

function manifestDoc(mutate) {
  const manifest = {
    schema: 'edilec.etl-manifest/v1',
    tool: 'etl-run-manifest',
    run: {
      runId: 'run-1',
      recordedAt: null,
      parentRunIds: [],
      transformation: { id: 'normalise', version: '1.0.0', code: [] },
      seed: null,
      parameters: [],
      secretRefs: [],
      inputs: [{ id: 'orders_raw', path: 'data/orders.csv', digest: 'a'.repeat(64), bytes: 8, unresolved: null }],
      outputs: [],
    },
    integrity: { algorithm: 'sha256', digest: 'b'.repeat(64) },
  }
  mutate(manifest)
  return manifest
}

const MANIFEST_REFUSALS = [
  ['a digest that is not 64 hex characters', (m) => { m.run.inputs[0].digest = 'not-a-digest' },
    '/run/inputs/0/digest', 'must be null or 64 lowercase hex characters (sha256)'],
  ['an uppercase digest', (m) => { m.run.inputs[0].digest = 'A'.repeat(64) },
    '/run/inputs/0/digest', 'must be null or 64 lowercase hex characters (sha256)'],
  ['a negative byte count', (m) => { m.run.inputs[0].bytes = -1 },
    '/run/inputs/0/bytes', 'must be null or a non-negative integer'],
  ['no digest and no reason', (m) => { m.run.inputs[0].digest = null; m.run.inputs[0].bytes = null },
    '/run/inputs/0', 'has no digest and no reason for not having one; an unrecorded digest must say why'],
  ['both a digest and a reason', (m) => { m.run.inputs[0].unresolved = 'not-found' },
    '/run/inputs/0', 'carries both a digest and a reason for not having one'],
  ['the wrong schema', (m) => { m.schema = 'edilec.etl-manifest/v2' },
    '/schema', 'must be "edilec.etl-manifest/v1"; this document declares "edilec.etl-manifest/v2"'],
  ['another tool', (m) => { m.tool = 'some-other-tool' }, '/tool', 'must be "etl-run-manifest"'],
  ['a digest algorithm this tool does not use', (m) => { m.integrity.algorithm = 'md5' },
    '/integrity/algorithm', 'must be "sha256"'],
  ['an integrity digest that is not hex', (m) => { m.integrity.digest = 'nope' },
    '/integrity/digest', 'must be 64 lowercase hex characters'],
  ['a required key that is missing', (m) => { delete m.run.seed },
    '/run/seed', 'is required and is missing'],
  ['a key the schema does not define', (m) => { m.run.notes = 'hello' },
    '/run/notes', 'is not a key this schema defines; allowed keys are inputs, outputs, parameters, parentRunIds, recordedAt, runId, secretRefs, seed, transformation'],
]

for (const [label, mutate, pointer, message] of MANIFEST_REFUSALS) {
  test(`a manifest with ${label} is refused, with its pointer and its reason`, () => {
    const compiled = compileManifest(manifestDoc(mutate))
    assert.equal(compiled.ok, false, `${label} was accepted`)
    const problem = compiled.problems.find((entry) => entry.pointer === pointer)
    assert.ok(problem !== undefined, `no problem at ${pointer}: ${JSON.stringify(compiled.problems)}`)
    assert.equal(problem.message, message)
  })
}

test('two problems at ONE pointer are both reported, in a documented order', () => {
  // A repeated dataset id and an entry with no digest and no reason land on the
  // same pointer, so this is the only shape in which two findings share a file,
  // a pointer AND a rule id. Both are reported -- neither is lost to the other
  // -- and the order is by message, which is the last sort key.
  const compiled = compileManifest(manifestDoc((m) => {
    m.run.inputs.push({ id: 'orders_raw', path: 'data/b.csv', digest: null, bytes: null, unresolved: null })
  }))
  assert.equal(compiled.ok, false)
  assert.deepEqual(compiled.problems, [
    {
      pointer: '/run/inputs/1',
      message: 'has no digest and no reason for not having one; an unrecorded digest must say why',
    },
    { pointer: '/run/inputs/1', message: 'repeats the dataset id "orders_raw"' },
  ])
})

test('a valid manifest of this shape compiles: the table above refuses the edit, not the shape', () => {
  const compiled = compileManifest(manifestDoc(() => {}))
  assert.equal(compiled.ok, true, JSON.stringify(compiled.problems))
  assert.equal(compiled.manifest.run.runId, 'run-1')
  assert.equal(compiled.manifest.run.inputs[0].digest, 'a'.repeat(64))
})

test('the pointer and the reason reach the report: a run description with a numeric runId', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDoc({ runId: 42 }))
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.deepEqual(ruleIds(recorded.report), ['run-description-invalid'])
  assert.equal(recorded.report.findings[0].location.pointer, '/runId')
  assert.equal(recorded.report.findings[0].message, '/runId must be a string, not number')
})

test('the pointer and the reason reach the report: a manifest digest that is not hex', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  manifest.run.inputs[0].digest = 'not-a-digest'
  write(directory, 'edited.json', `${JSON.stringify(manifest, null, 2)}\n`)
  const verified = runJson(['verify', '--root', directory, '--manifest', join(directory, 'edited.json'), '--quiet'])
  assert.equal(verified.status, 2)
  // Two problems, because a digest the schema cannot read is no digest -- and
  // an entry with no digest must say why it has none. Both are reported, at
  // their own pointers, rather than the first one found.
  assert.deepEqual(ruleIds(verified.report), ['manifest-invalid', 'manifest-invalid'])
  assert.deepEqual(
    verified.report.findings.map((finding) => [finding.location.pointer, finding.message]),
    [
      ['/run/inputs/0', '/run/inputs/0 has no digest and no reason for not having one; an unrecorded digest must say why'],
      ['/run/inputs/0/digest', '/run/inputs/0/digest must be null or 64 lowercase hex characters (sha256)'],
    ],
  )
})
