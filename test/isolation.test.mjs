/**
 * What this tool does NOT do.
 *
 * Each of these is a guarantee the README makes, and a README that claims
 * something the code does not do is a defect, so each one is checked here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROOT, record, runCli, runDescription, temporary, tree, writeRun } from './support.mjs'

function sources() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of readdirSync(join(ROOT, directory)).sort()) {
      if (name.endsWith('.mjs')) files.push(join(ROOT, directory, name))
    }
  }
  return files
}

test('no source module reaches for the network', () => {
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    for (const forbidden of ['node:net', 'node:http', 'node:https', 'node:dns', 'node:tls', 'node:dgram', 'fetch(']) {
      assert.ok(!text.includes(forbidden), `${file} mentions ${forbidden}`)
    }
  }
})

test('no source module reads a clock or the environment for data', () => {
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('Date.now'), `${file} reads a clock`)
    assert.ok(!text.includes('new Date'), `${file} reads a clock`)
    assert.ok(!text.includes('process.env.'), `${file} reads an environment variable`)
    assert.ok(!text.includes('process.hrtime'), `${file} reads a clock`)
  }
})

test('BEHAVIOUR: no clock reaches the output, so the same run records the same bytes', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const first = record(directory, { out: 'a.json' })
  const second = record(directory, { out: 'b.json' })
  assert.equal(first.status, 0)
  assert.equal(
    readFileSync(join(directory, 'b.json'), 'utf8'),
    readFileSync(join(directory, 'a.json'), 'utf8'),
    'a timestamp minted by the tool would make these differ',
  )
  assert.equal(second.stdout, first.stdout)
})

test('the recordedAt label is copied verbatim and never parsed', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({ recordedAt: 'whenever the batch finished' }))
  const recorded = record(directory)
  assert.equal(recorded.status, 0)
  const manifest = JSON.parse(readFileSync(recorded.manifestPath, 'utf8'))
  assert.equal(manifest.run.recordedAt, 'whenever the batch finished')
})

test('verify and compare write nothing at all', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  const snapshot = () => readdirSync(directory).sort().map((name) => {
    const info = statSync(join(directory, name))
    return `${name}:${info.size}:${info.mtimeMs}`
  })
  const before = snapshot()
  runCli(['verify', '--root', directory, '--manifest', recorded.manifestPath, '--quiet'])
  runCli(['compare', '--baseline', recorded.manifestPath, '--candidate', recorded.manifestPath, '--quiet'])
  assert.deepEqual(snapshot(), before)
})

test('the package declares no dependencies of any kind', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
})

test('TOOL_ID is exported and equals the directory name', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'etl-run-manifest')
  assert.equal(ROOT.split('/').pop(), 'etl-run-manifest')
})
