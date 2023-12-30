import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = join(ROOT, 'bin', 'etl-run-manifest.mjs')

/** Run the real CLI in a child process. Nothing here stubs the entry point. */
export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

export function runJson(args, options = {}) {
  const result = runCli(args, options)
  return { ...result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'etl-run-manifest-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

export function write(directory, relativePath, contents) {
  const target = join(directory, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, 'utf8')
  return target
}

/** A run description that names one input, one output and one code file. */
export function runDescription(overrides = {}) {
  return {
    schema: 'edilec.etl-run/v1',
    runId: 'run-1',
    recordedAt: '2026-09-18T02:14:03Z',
    parentRunIds: [],
    transformation: { id: 'normalise', version: '1.0.0', code: [{ path: 'sql/t.sql' }] },
    seed: 7,
    parameters: [{ name: 'batch_size', value: 500 }],
    secretRefs: [{ name: 'WAREHOUSE_READER', source: 'env' }],
    inputs: [{ id: 'orders_raw', path: 'data/orders.csv' }],
    outputs: [{ id: 'orders', path: 'out/orders.tsv' }],
    ...overrides,
  }
}

/** A complete, readable tree matching `runDescription()`. */
export function tree(directory, { orders = 'a,b\n1,2\n', output = 'a\tb\n1\t2\n', sql = 'SELECT 1;\n' } = {}) {
  write(directory, 'data/orders.csv', orders)
  write(directory, 'out/orders.tsv', output)
  write(directory, 'sql/t.sql', sql)
  return directory
}

export function writeRun(directory, description = runDescription(), name = 'run.json') {
  return write(directory, name, `${JSON.stringify(description, null, 2)}\n`)
}

/** Record a manifest and return its path. Asserts nothing: callers do that. */
export function record(directory, { runName = 'run.json', out = 'manifest.json', args = [], env = {} } = {}) {
  const outPath = join(directory, out)
  const result = runJson(
    ['record', '--root', directory, '--run', join(directory, runName), '--out', outPath, '--quiet', ...args],
    { env },
  )
  return { ...result, manifestPath: outPath }
}
