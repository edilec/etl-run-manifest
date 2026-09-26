/**
 * Path confinement for declared inputs.
 *
 * Rejecting "../" and absolute paths is not confinement: a symlink planted
 * inside a declared root was followed out of the tree in another tool here, and
 * out-of-root content was echoed into the report. The REAL path is resolved and
 * compared against the REAL root.
 *
 * And a guard that refuses everything is worse than none, so the allowed cases
 * are pinned beside the refused ones.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { record, ruleIds, runDescription, temporary, tree, write, writeRun } from './support.mjs'

test('a symbolic link that leaves the root is refused, and its content is never read', (t) => {
  const directory = temporary(t)
  const root = join(directory, 'root')
  tree(root)
  writeFileSync(join(directory, 'outside.csv'), 'out-of-root-content\n', 'utf8')
  symlinkSync(join(directory, 'outside.csv'), join(root, 'data/escape.csv'))
  writeRun(root, runDescription({ inputs: [{ id: 'escape', path: 'data/escape.csv' }] }))

  const recorded = record(root)
  assert.equal(recorded.status, 2)
  assert.ok(ruleIds(recorded.report).includes('path-outside-root'))
  const finding = recorded.report.findings.find((entry) => entry.ruleId === 'path-outside-root')
  assert.equal(finding.location.file, 'data/escape.csv')
  assert.match(finding.message, /resolves outside the declared root/)
  assert.ok(!recorded.stdout.includes('out-of-root-content'))
})

test('ALLOWED: a symbolic link that stays inside the root is followed and hashed', (t) => {
  const directory = temporary(t)
  tree(directory)
  mkdirSync(join(directory, 'link'), { recursive: true })
  symlinkSync(join(directory, 'data/orders.csv'), join(directory, 'link/orders.csv'))
  writeRun(directory, runDescription({ inputs: [{ id: 'linked', path: 'link/orders.csv' }] }))

  const recorded = record(directory)
  assert.equal(recorded.status, 0, 'a link inside the root is an ordinary file')
  assert.deepEqual(ruleIds(recorded.report), ['manifest-recorded'])
  assert.equal(recorded.report.summary.recorded, 3)
})

test('a lexically absolute or dot-dot path is refused by the schema', (t) => {
  const directory = temporary(t)
  tree(directory)
  for (const [path, expected] of [['/etc/hosts', /absolute/], ['../outside.csv', /".." segment/], ['data//orders.csv', /empty/]]) {
    writeRun(directory, runDescription({ inputs: [{ id: 'x', path }] }))
    const recorded = record(directory)
    assert.equal(recorded.status, 2, path)
    assert.deepEqual(ruleIds(recorded.report), ['run-description-invalid'])
    assert.match(recorded.report.findings[0].message, expected)
  }
})

test('a declared path that is a directory is unresolved, not hashed', (t) => {
  const directory = temporary(t)
  tree(directory)
  write(directory, 'data/nested/inner.csv', 'a\n')
  writeRun(directory, runDescription({ inputs: [{ id: 'dir', path: 'data/nested' }] }))
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.ok(ruleIds(recorded.report).includes('file-unreadable'))
  assert.match(
    recorded.report.findings.find((entry) => entry.ruleId === 'file-unreadable').message,
    /is not a regular file/,
  )
})
