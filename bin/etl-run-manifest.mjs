#!/usr/bin/env node

/**
 * The command line surface.
 *
 * Two shapes of exit 2, as the report contract requires and as consumers
 * piping stdout depend on:
 *
 *   bad usage, unknown option, unusable destination -> EMPTY stdout, message on
 *   stderr. The run never had a subject, so there is nothing to report about.
 *
 *   an input that could not be read, decoded, parsed or verified -> a report on
 *   stdout with status "incomplete". The run had a subject and failed to obtain
 *   evidence about it, and the consumer needs to know WHICH input.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import {
  DestinationError,
  LIMITS,
  OVERRIDABLE,
  assertWritableDestination,
  canonicalDocument,
  compareManifests,
  exitCodeFor,
  formatReport,
  recordRun,
  resolveRoot,
  serializeReport,
  verifyManifest,
} from '../src/index.mjs'

const VERSION = '0.1.0'

class ConfigError extends Error {}

const COMMANDS = Object.freeze({
  record: ['--root', '--run', '--out'],
  verify: ['--root', '--manifest'],
  compare: ['--baseline', '--candidate'],
})

const HELP = `etl-run-manifest ${VERSION}

Record what one ETL run consumed, ran and produced; verify that the record
still holds; compare two runs that were meant to be the same run twice.

Nothing here opens a socket, resolves a host, reads an environment variable or
reads a clock. Every input is a document somebody exported and a file somebody
produced, and the manifest's own timestamp is whatever the run description
declares.

CREDENTIALS. The run description has no field for a credential value. A
credential is named in "secretRefs" as a name and a source kind -- "env",
"file", "keychain", "parameter-store", "vault" or "other" -- and the value is
never fetched, because this tool reads no environment and no secret store.
Excluding a secret is not something done to a value this tool holds; it never
holds one. Any key the schema does not name is refused outright, so a
"password" sitting beside a recorded parameter does not travel either.

UNKNOWN IS NEVER A PASS. A file that could not be read is recorded with no
digest and a reason, never left out of the manifest -- a gap reads as "no such
input". Verifying an entry with no digest is not a verification, and comparing
two entries that both lack a digest is not a match. Both make the run
incomplete and exit 2.

Usage:
  etl-run-manifest record  --root DIR --run FILE --out FILE [options]
  etl-run-manifest verify  --root DIR --manifest FILE [options]
  etl-run-manifest compare --baseline FILE --candidate FILE [options]
  etl-run-manifest --help | --version

Commands:
  record   Hash everything the run description names and write one manifest.
           A manifest is written even when some file could not be read; it says
           so per entry, and the run still exits 2.
  verify   Re-hash everything a manifest recorded and compare it with the
           recorded digests. A changed input is exit 1.
  compare  Decide whether two manifests describe one run repeated.

Options:
  --root DIR          Directory the declared relative paths resolve inside.
                      A path that resolves outside the real root is refused,
                      symbolic links included.
  --run FILE          The run description to record (a path, not confined).
  --manifest FILE     The manifest to verify (a path, not confined).
  --baseline FILE     The earlier manifest (a path, not confined).
  --candidate FILE    The later manifest (a path, not confined).
  --out FILE          Where to write the manifest. The destination is checked
                      first: a symbolic link there is refused, and a hard link
                      to any file this run resolved is refused. The destination
                      is NOT confined to --root -- it is an ordinary path and a
                      symbolically linked parent directory is followed, exactly
                      as it is for cp and shell redirection.
  --quiet             Do not write the human summary to stderr.
  --max-document-bytes N   Bytes of one JSON document (default ${LIMITS.maxDocumentBytes}).
  --max-file-bytes N       Bytes of one hashed file (default ${LIMITS.maxFileBytes}).
  --max-inputs N           Inputs per run (default ${LIMITS.maxInputs}).
  --max-outputs N          Outputs per run (default ${LIMITS.maxOutputs}).
  --max-code-files N       Code files per run (default ${LIMITS.maxCodeFiles}).
  --max-parameters N       Parameters per run (default ${LIMITS.maxParameters}).
  --max-secret-refs N      Secret references per run (default ${LIMITS.maxSecretRefs}).
  --max-parent-runs N      Parent run ids (default ${LIMITS.maxParentRuns}).
  --max-findings N         Findings per report (default ${LIMITS.maxFindings}).

Exit codes:
  0  the check completed and the policy is satisfied
  1  the check completed and the policy failed (a digest no longer matches, two
     runs are not the same run, a manifest does not match its own digest)
  2  invalid usage or an unusable destination (empty stdout), or evidence that
     could not be obtained (a report with status "incomplete")

stdout carries the JSON report and nothing else. stderr carries the human
summary. --help and --version print text and produce no report.
`

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  if (argv.includes('--version')) return { version: true }
  const command = argv[0]
  if (command === undefined) throw new ConfigError('a command is required: record, verify or compare')
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new ConfigError(`unknown command "${command}"; expected record, verify or compare`)
  }
  const accepted = new Set([...COMMANDS[command], ...Object.keys(OVERRIDABLE)])
  const values = new Map()
  const limits = { ...LIMITS }
  let quiet = false
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--quiet') {
      quiet = true
      continue
    }
    if (!accepted.has(token)) throw new ConfigError(`unknown option "${token}" for ${command}`)
    if (values.has(token)) throw new ConfigError(`option "${token}" was given more than once`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ConfigError(`option "${token}" needs a value`)
    index += 1
    if (Object.hasOwn(OVERRIDABLE, token)) {
      if (!/^[0-9]+$/.test(value)) throw new ConfigError(`option "${token}" needs a whole number, not "${value}"`)
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new ConfigError(`option "${token}" needs a whole number of at least 1`)
      }
      limits[OVERRIDABLE[token]] = parsed
      continue
    }
    values.set(token, value)
  }
  for (const required of COMMANDS[command]) {
    if (!values.has(required)) throw new ConfigError(`option "${required}" is required for ${command}`)
  }
  return { command, values, limits: Object.freeze(limits), quiet }
}

async function realRootOf(values) {
  try {
    return await resolveRoot(values.get('--root'))
  } catch {
    throw new ConfigError('--root could not be resolved; name a directory that exists')
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const { command, values, limits, quiet } = parsed

  if (command === 'record') {
    const realRoot = await realRootOf(values)
    const runPath = resolve(process.cwd(), values.get('--run'))
    const result = await recordRun({ runPath, realRoot, limits })
    if (result.manifest !== null) {
      const target = await assertWritableDestination(values.get('--out'), {
        inputs: [runPath, ...(result.touched ?? [])],
        root: null,
        label: '--out',
      })
      await writeFile(target, canonicalDocument(result.manifest), 'utf8')
    }
    process.stdout.write(serializeReport(result.report))
    if (!quiet) {
      const headline = result.manifest === null
        ? 'no manifest was written'
        : `manifest written for run "${result.manifest.run.runId}"`
      process.stderr.write(formatReport(result.report, headline))
    }
    return exitCodeFor(result.report)
  }

  if (command === 'verify') {
    const realRoot = await realRootOf(values)
    const report = await verifyManifest({
      manifestPath: resolve(process.cwd(), values.get('--manifest')),
      realRoot,
      limits,
    })
    process.stdout.write(serializeReport(report))
    if (!quiet) process.stderr.write(formatReport(report, 'verification of a recorded manifest'))
    return exitCodeFor(report)
  }

  const report = await compareManifests({
    baselinePath: resolve(process.cwd(), values.get('--baseline')),
    candidatePath: resolve(process.cwd(), values.get('--candidate')),
    limits,
  })
  process.stdout.write(serializeReport(report))
  if (!quiet) process.stderr.write(formatReport(report, 'comparison of two recorded manifests'))
  return exitCodeFor(report)
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof ConfigError || error instanceof DestinationError) {
    process.stderr.write(`etl-run-manifest: ${error.message}\n`)
    process.exitCode = 2
  } else {
    throw error
  }
}
