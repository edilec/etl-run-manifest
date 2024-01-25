/**
 * The command-line surface, and the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout is EMPTY
 * and the message goes to stderr. An input that could not be read means the run
 * had a subject and failed to obtain evidence about it, so stdout carries a
 * report with status "incomplete". A consumer piping stdout has to handle both,
 * which is why both are pinned here rather than described.
 *
 * Each case also pins WHICH refusal fired. A table that asserted only the shape
 * -- exit 2, empty stdout, a stderr prefix -- was satisfied by any refusal at
 * all: deleting the guard that rejects a non-numeric bound left "lots" falling
 * through to the "at least 1" throw, and the suite stayed green while a
 * mistyped bound stopped being reported as a mistyped bound. Contract defect 6
 * is the risk: a one-character typo must not turn a real failure into a green
 * run, and the way to keep that true is to assert the sentence the user is
 * actually shown.
 */

import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { record, runCli, temporary, tree, writeRun } from './support.mjs'

const USAGE = [
  {
    label: 'no command',
    args: [],
    stderr: 'etl-run-manifest: a command is required: record, verify or compare\n',
  },
  {
    label: 'an unknown command',
    args: ['inspect', '--root', '.'],
    stderr: 'etl-run-manifest: unknown command "inspect"; expected record, verify or compare\n',
  },
  {
    label: 'an unknown option',
    args: ['record', '--root', '.', '--run', 'r.json', '--out', 'o.json', '--verbose'],
    stderr: 'etl-run-manifest: unknown option "--verbose" for record\n',
  },
  {
    label: 'an option from another command',
    args: ['verify', '--root', '.', '--manifest', 'm.json', '--baseline', 'b.json'],
    stderr: 'etl-run-manifest: unknown option "--baseline" for verify\n',
  },
  {
    label: 'a missing required option',
    args: ['record', '--root', '.', '--run', 'r.json'],
    stderr: 'etl-run-manifest: option "--out" is required for record\n',
  },
  {
    label: 'a repeated option',
    args: ['verify', '--root', '.', '--manifest', 'a.json', '--manifest', 'b.json'],
    stderr: 'etl-run-manifest: option "--manifest" was given more than once\n',
  },
  {
    label: 'an option with no value',
    args: ['verify', '--root', '.', '--manifest'],
    stderr: 'etl-run-manifest: option "--manifest" needs a value\n',
  },
  {
    label: 'a non-numeric bound',
    args: ['verify', '--root', '.', '--manifest', 'm.json', '--max-inputs', 'lots'],
    stderr: 'etl-run-manifest: option "--max-inputs" needs a whole number, not "lots"\n',
  },
  {
    label: 'a bound of zero',
    args: ['verify', '--root', '.', '--manifest', 'm.json', '--max-inputs', '0'],
    stderr: 'etl-run-manifest: option "--max-inputs" needs a whole number of at least 1\n',
  },
  {
    label: 'a negative bound',
    args: ['verify', '--root', '.', '--manifest', 'm.json', '--max-inputs', '-4'],
    stderr: 'etl-run-manifest: option "--max-inputs" needs a whole number, not "-4"\n',
  },
]

for (const { label, args, stderr } of USAGE) {
  test(`${label} is a configuration error: exit 2, EMPTY stdout, and the reason`, () => {
    const result = runCli(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '', 'a run that never had a subject reports nothing')
    assert.equal(result.stderr, stderr)
  })
}

test('a --root that does not exist is a configuration error, not an incomplete report', () => {
  const result = runCli(['verify', '--root', '/no/such/root/here', '--manifest', 'm.json'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--root could not be resolved/)
})

test('a manifest that does not exist IS an incomplete report on stdout', (t) => {
  const directory = temporary(t)
  const result = runCli(['verify', '--root', directory, '--manifest', join(directory, 'nope.json'), '--quiet'])
  assert.equal(result.status, 2)
  assert.notEqual(result.stdout, '', 'the run had a subject; the consumer needs to know which input')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'manifest-unreadable')
})

test('--help explains the tool and exits 0', () => {
  const result = runCli(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /etl-run-manifest/)
  assert.match(result.stdout, /UNKNOWN IS NEVER A PASS/)
  assert.match(result.stdout, /CREDENTIALS/)
  assert.match(result.stdout, /Exit codes:/)
})

test('--version prints a version and exits 0', () => {
  const result = runCli(['--version'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/)
})

test('stdout is JSON and nothing else; the human summary goes to stderr', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const result = runCli(['record', '--root', directory, '--run', join(directory, 'run.json'), '--out', join(directory, 'm.json')])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.tool, 'etl-run-manifest')
  assert.equal(report.schemaVersion, '1')
  assert.match(result.stderr, /^etl-run-manifest: manifest written/)
  assert.match(result.stderr, /status pass/)
})

test('--quiet silences the human summary and leaves stdout untouched', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const loud = runCli(['record', '--root', directory, '--run', join(directory, 'run.json'), '--out', join(directory, 'a.json')])
  const quiet = runCli(['record', '--root', directory, '--run', join(directory, 'run.json'), '--out', join(directory, 'b.json'), '--quiet'])
  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, loud.stdout)
})

test('running twice over identical inputs produces byte-identical stdout', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const first = record(directory)
  const second = record(directory, { out: 'manifest-2.json' })
  assert.equal(second.stdout, first.stdout)
})

test('every finding carries the fields the report contract defines and no others', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory)
  const allowed = ['evidence', 'location', 'message', 'ruleId', 'severity', 'suggestion']
  for (const finding of recorded.report.findings) {
    for (const key of Object.keys(finding)) assert.ok(allowed.includes(key), `unexpected finding key ${key}`)
    assert.ok(['error', 'warning', 'info'].includes(finding.severity))
    assert.equal(typeof finding.location.file, 'string')
    assert.ok(!finding.location.file.startsWith('/'), 'a location is never an absolute host path')
  }
  assert.deepEqual(Object.keys(recorded.report).sort(), ['findings', 'schemaVersion', 'status', 'summary', 'tool'])
})
