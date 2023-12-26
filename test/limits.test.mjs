/**
 * Every declared bound, from BOTH sides.
 *
 * Across the last batch every documented limit was driven only from the N+1
 * side, so widening any comparison by one started refusing documents sitting
 * exactly on a legal limit with the whole suite green -- 20 silent mutations in
 * one tool and 17 in another. "Fires at N+1" and "silent at N" are two
 * assertions, and the second is the one users notice.
 *
 * The bounds are enforced BEFORE the work: a document's size comes from `stat`
 * before its bytes are read, a file's size comes from `stat` before it is
 * opened, and every count is checked against the parsed document before any
 * file is opened. A legal-sized input cannot exhaust memory here.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { LIMITS, compileRunDescription } from '../src/index.mjs'
import { record, ruleIds, runDescription, temporary, tree, write, writeRun } from './support.mjs'

function at(directory, description, args) {
  writeRun(directory, description)
  return record(directory, { args })
}

test('maxDocumentBytes: a document of exactly the limit is read, one byte over is refused', (t) => {
  const directory = temporary(t)
  tree(directory)
  const runPath = writeRun(directory)
  const size = statSync(runPath).size

  const exact = record(directory, { args: ['--max-document-bytes', String(size)] })
  assert.equal(exact.status, 0, 'a document sitting exactly on the limit is legal')
  assert.equal(exact.report.status, 'pass')

  const over = record(directory, { out: 'm2.json', args: ['--max-document-bytes', String(size - 1)] })
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.deepEqual(ruleIds(over.report), ['run-description-unreadable'])
  assert.match(over.report.findings[0].message, new RegExp(`over the document limit of ${size - 1}`))
})

test('maxFileBytes: a file of exactly the limit is hashed, one byte over is not', (t) => {
  const directory = temporary(t)
  tree(directory, { orders: 'ab\n', output: 'cd\n', sql: 'ef\n' })
  writeRun(directory)

  const exact = record(directory, { args: ['--max-file-bytes', '3'] })
  assert.equal(exact.status, 0)
  assert.deepEqual(ruleIds(exact.report), ['manifest-recorded'])
  assert.equal(exact.report.summary.recorded, 3)

  const over = record(directory, { out: 'm2.json', args: ['--max-file-bytes', '2'] })
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.equal(over.report.summary.unresolved, 3)
  assert.ok(ruleIds(over.report).includes('file-too-large'))
  const manifest = JSON.parse(readFileSync(over.manifestPath, 'utf8'))
  assert.equal(manifest.run.inputs[0].unresolved, 'too-large')
  assert.equal(manifest.run.inputs[0].digest, null)
})

const COUNTS = [
  {
    flag: '--max-inputs',
    key: 'maxInputs',
    build: (count) => runDescription({
      inputs: Array.from({ length: count }, (unused, index) => ({ id: `in-${index}`, path: 'data/orders.csv' })),
    }),
  },
  {
    flag: '--max-outputs',
    key: 'maxOutputs',
    build: (count) => runDescription({
      outputs: Array.from({ length: count }, (unused, index) => ({ id: `out-${index}`, path: 'out/orders.tsv' })),
    }),
  },
  {
    flag: '--max-code-files',
    key: 'maxCodeFiles',
    build: (count) => runDescription({
      transformation: {
        id: 'normalise',
        version: '1.0.0',
        code: Array.from({ length: count }, (unused, index) => ({ path: `sql/t${index}.sql` })),
      },
    }),
  },
  {
    flag: '--max-parameters',
    key: 'maxParameters',
    build: (count) => runDescription({
      parameters: Array.from({ length: count }, (unused, index) => ({ name: `p-${index}`, value: index })),
    }),
  },
  {
    flag: '--max-secret-refs',
    key: 'maxSecretRefs',
    build: (count) => runDescription({
      secretRefs: Array.from({ length: count }, (unused, index) => ({ name: `s-${index}`, source: 'env' })),
    }),
  },
  {
    flag: '--max-parent-runs',
    key: 'maxParentRuns',
    build: (count) => runDescription({
      parentRunIds: Array.from({ length: count }, (unused, index) => `parent-${index}`),
    }),
  },
]

for (const bound of COUNTS) {
  test(`${bound.flag}: exactly the limit is accepted and one over is refused`, (t) => {
    const directory = temporary(t)
    tree(directory)
    for (let index = 0; index < 4; index += 1) write(directory, `sql/t${index}.sql`, 'SELECT 1;\n')

    const exact = at(directory, bound.build(3), [bound.flag, '3'])
    assert.equal(exact.status, 0, `${bound.flag} refused a document sitting exactly on the limit`)
    assert.equal(exact.report.status, 'pass')

    const over = at(directory, bound.build(4), [bound.flag, '3'])
    assert.equal(over.status, 2)
    assert.equal(over.report.status, 'incomplete')
    assert.deepEqual(ruleIds(over.report), ['run-description-invalid'])
    assert.match(over.report.findings[0].message, /over the limit of 3/)
  })
}

test('maxIdentifierChars: an identifier of exactly the limit is accepted, one over is refused', (t) => {
  const directory = temporary(t)
  tree(directory)

  const exact = at(directory, runDescription({ runId: 'r'.repeat(LIMITS.maxIdentifierChars) }), [])
  assert.equal(exact.status, 0)
  assert.equal(exact.report.status, 'pass')

  const over = at(directory, runDescription({ runId: 'r'.repeat(LIMITS.maxIdentifierChars + 1) }), [])
  assert.equal(over.status, 2)
  assert.deepEqual(ruleIds(over.report), ['run-description-invalid'])
  assert.equal(over.report.findings[0].location.pointer, '/runId')
  assert.match(over.report.findings[0].message, new RegExp(`over the limit of ${LIMITS.maxIdentifierChars}`))
})

test('maxValueChars: a parameter value of exactly the limit is accepted, one over is refused', (t) => {
  const directory = temporary(t)
  tree(directory)

  const exact = at(directory, runDescription({
    parameters: [{ name: 'note', value: 'v'.repeat(LIMITS.maxValueChars) }],
  }), [])
  assert.equal(exact.status, 0)
  assert.equal(exact.report.status, 'pass')

  const over = at(directory, runDescription({
    parameters: [{ name: 'note', value: 'v'.repeat(LIMITS.maxValueChars + 1) }],
  }), [])
  assert.equal(over.status, 2)
  assert.equal(over.report.findings[0].location.pointer, '/parameters/0/value')
})

test('maxPathChars: a declared path of exactly the limit compiles, one over does not', () => {
  const longPath = `data/${'p'.repeat(LIMITS.maxPathChars - 5)}`
  assert.equal(longPath.length, LIMITS.maxPathChars)
  const exact = compileRunDescription(runDescription({ inputs: [{ id: 'orders_raw', path: longPath }] }))
  assert.equal(exact.ok, true, 'a path sitting exactly on the limit is legal')
  assert.equal(exact.run.inputs[0].path, longPath)

  const over = compileRunDescription(runDescription({ inputs: [{ id: 'orders_raw', path: `${longPath}q` }] }))
  assert.equal(over.ok, false)
  assert.deepEqual(over.problems.map((problem) => problem.pointer), ['/inputs/0/path'])
  assert.match(over.problems[0].message, new RegExp(`over the limit of ${LIMITS.maxPathChars}`))
})

test('maxFindings: exactly the limit is reported in full, one more says the report is not complete', (t) => {
  const directory = temporary(t)
  tree(directory)
  const missing = (count) => runDescription({
    inputs: Array.from({ length: count }, (unused, index) => ({ id: `in-${index}`, path: `data/missing-${index}.csv` })),
  })

  // 3 missing inputs + the manifest-recorded note = 4 findings.
  const exact = at(directory, missing(3), ['--max-findings', '4'])
  assert.equal(exact.report.findings.length, 4)
  assert.ok(!ruleIds(exact.report).includes('finding-limit-reached'))
  assert.equal(exact.report.summary.unresolved, 3)

  const over = at(directory, missing(4), ['--max-findings', '4'])
  assert.equal(over.status, 2)
  assert.equal(over.report.status, 'incomplete')
  assert.ok(ruleIds(over.report).includes('finding-limit-reached'))
  assert.match(
    over.report.findings.find((finding) => finding.ruleId === 'finding-limit-reached').message,
    /does not describe everything that was observed/,
  )
})

test('the documented defaults are the ones the tool actually uses', () => {
  assert.deepEqual(Object.keys(LIMITS).sort(), [
    'maxCodeFiles', 'maxDocumentBytes', 'maxFileBytes', 'maxFindings', 'maxIdentifierChars', 'maxInputs',
    'maxOutputs', 'maxParameters', 'maxParentRuns', 'maxPathChars', 'maxSecretRefs', 'maxValueChars',
  ])
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')
  for (const [key, value] of Object.entries(LIMITS)) {
    assert.ok(readme.includes(`${key}\` | ${value}`), `README does not document ${key} as ${value}`)
  }
})
