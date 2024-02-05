/**
 * The good case, twenty-four ways.
 *
 * The first verification of a checker is not "does it catch the bad input". It
 * is "does it stay silent on the good one", built by somebody who knows what
 * good looks like. A miss leaves a reader where they were; a finding raised on
 * correct input sends somebody to fix what was already right, and once a
 * checker has done that twice nobody reads its output again.
 *
 * Every run description below is one a data engineer would call correct. Each
 * is recorded, verified and compared with itself through the real CLI, and all
 * three must exit 0 with nothing above `info` severity.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { LIMITS } from '../src/index.mjs'
import { record, runJson, ruleIds, runDescription, temporary, tree, write, writeRun } from './support.mjs'

const CODE = [{ path: 'sql/t.sql' }]
const without = (key) => {
  const description = runDescription()
  delete description[key]
  return description
}

const CORRECT = [
  ['a seed that is a string', runDescription({ seed: 'deadbeef' })],
  ['a seed that is null', runDescription({ seed: null })],
  ['no seed at all', without('seed')],
  ['a free-text recordedAt label', runDescription({ recordedAt: 'whenever the batch finished' })],
  ['no recordedAt at all', without('recordedAt')],
  ['a parameter value of null', runDescription({ parameters: [{ name: 'cutoff', value: null }] })],
  ['a parameter value of false', runDescription({ parameters: [{ name: 'drop_cancelled', value: false }] })],
  ['a parameter value of 0', runDescription({ parameters: [{ name: 'retries', value: 0 }] })],
  ['a fractional parameter value', runDescription({ parameters: [{ name: 'sample_rate', value: 0.125 }] })],
  ['a parameter value that is one space', runDescription({ parameters: [{ name: 'suffix', value: ' ' }] })],
  ['no parameters key', without('parameters')],
  ['no secretRefs key', without('secretRefs')],
  ['an empty code list', runDescription({ transformation: { id: 'normalise', version: '1.0.0', code: [] } })],
  ['no code key', runDescription({ transformation: { id: 'normalise', version: '1.0.0' } })],
  ['parent run ids', runDescription({ parentRunIds: ['extract-2026-09-18', 'extract-2026-09-17'] })],
  ['the same file as an input and an output', runDescription({ outputs: [{ id: 'orders_copy', path: 'data/orders.csv' }] })],
  ['two ids for one path', runDescription({
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }, { id: 'orders_again', path: 'data/orders.csv' }],
  })],
  ['one path as a code file and an input', runDescription({ inputs: [{ id: 'the_sql', path: 'sql/t.sql' }] })],
  ['ids with dots, dashes and slashes', runDescription({
    inputs: [{ id: 'warehouse.raw/orders-2026', path: 'data/orders.csv' }],
  })],
  ['every secret source kind at once', runDescription({
    secretRefs: ['env', 'file', 'keychain', 'parameter-store', 'vault', 'other']
      .map((source, index) => ({ name: `CRED_${index}`, source })),
  })],
  ['a version with build metadata', runDescription({ transformation: { id: 'normalise', version: '1.0.0+build.99', code: CODE } })],
  ['a deep path', runDescription({ inputs: [{ id: 'orders_raw', path: 'data/2026/09/18/eu-west/orders.csv' }] })],
  ['non-ASCII in an id and a parameter', runDescription({
    inputs: [{ id: 'commandes_brutes_€', path: 'data/orders.csv' }],
    parameters: [{ name: 'région', value: 'eu-ouest' }],
  })],
  ['an identifier of exactly the maximum length', runDescription({ runId: 'r'.repeat(LIMITS.maxIdentifierChars) })],
]

function prepare(t) {
  const directory = temporary(t)
  tree(directory)
  write(directory, 'data/2026/09/18/eu-west/orders.csv', 'a,b\n1,2\n')
  writeFileSync(join(directory, 'data/orders.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]))
  return directory
}

for (const [label, description] of CORRECT) {
  test(`CORRECT INPUT: ${label}`, (t) => {
    const directory = prepare(t)
    writeRun(directory, description)

    const recorded = record(directory)
    assert.equal(recorded.status, 0, `record: ${JSON.stringify(ruleIds(recorded.report))}`)
    assert.deepEqual(ruleIds(recorded.report), ['manifest-recorded'])

    const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
    assert.equal(verified.status, 0, `verify: ${JSON.stringify(ruleIds(verified.report))}`)
    assert.deepEqual(ruleIds(verified.report), ['verification-complete'])

    const compared = runJson([
      'compare', '--baseline', recorded.manifestPath, '--candidate', recorded.manifestPath, '--quiet',
    ])
    assert.equal(compared.status, 0, `compare: ${JSON.stringify(ruleIds(compared.report))}`)
    assert.deepEqual(ruleIds(compared.report), ['runs-reproduced'])
    for (const finding of [...recorded.report.findings, ...verified.report.findings, ...compared.report.findings]) {
      assert.equal(finding.severity, 'info', `${finding.ruleId} is not info severity on correct input`)
    }
  })
}

test('CORRECT INPUT: a binary input is hashed like any other file', (t) => {
  const directory = prepare(t)
  writeRun(directory, runDescription({ inputs: [{ id: 'orders_raw', path: 'data/orders.bin' }] }))
  const recorded = record(directory)
  assert.equal(recorded.status, 0)
  assert.deepEqual(ruleIds(recorded.report), ['manifest-recorded'])
  const verified = runJson(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  assert.equal(verified.status, 0, 'bytes that are not UTF-8 are still bytes to hash')
})
