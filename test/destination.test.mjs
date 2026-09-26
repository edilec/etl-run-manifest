/**
 * The destination guard.
 *
 * Fifteen tools in this catalog destroyed a file they were never asked to
 * touch, and eight of them exited 0 reporting success. The three holes are
 * independent -- guarding one or two is what every one of those tools had
 * already done -- so there is a test per hole AND a test per allowed case,
 * because a guard that refuses everything passes a data-loss test while making
 * the tool useless.
 *
 * Hole 2 (a symbolically linked parent directory) is NOT a defect here and is
 * not guarded: `--out` takes an ordinary path and this tool declares no
 * confinement root for it, exactly as `cp` and shell redirection do. Refusing
 * every symlinked ancestor would refuse every run under the macOS temporary
 * directory, since /var is a link to /private/var. The behaviour is pinned
 * below, and the help text and README say the same thing -- documenting a
 * confinement the code does not perform is worse than silence.
 */

import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import assert from 'node:assert/strict'

import { ROOT, record, runCli, temporary, tree, writeRun } from './support.mjs'

function prepared(t) {
  const directory = temporary(t)
  const root = join(directory, 'root')
  tree(root)
  writeRun(root)
  return { directory, root }
}

function attemptWrite(root, out, extra = []) {
  return runCli(['record', '--root', root, '--run', join(root, 'run.json'), '--out', out, '--quiet', ...extra])
}

test('HOLE 1: a symbolic link at the destination is refused on sight', (t) => {
  const { directory, root } = prepared(t)
  const victim = join(directory, 'somebody-elses-notes.txt')
  writeFileSync(victim, 'keep me\n', 'utf8')
  const out = join(directory, 'manifest.json')
  symlinkSync(victim, out)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, and it reports nothing')
  assert.match(result.stderr, /symbolic link/)
  assert.equal(readFileSync(victim, 'utf8'), 'keep me\n', 'the link target is untouched')
})

test('HOLE 3: a hard link to a file this run read is refused', (t) => {
  const { directory, root } = prepared(t)
  const out = join(directory, 'manifest.json')
  linkSync(join(root, 'data/orders.csv'), out)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inode/)
  assert.equal(readFileSync(join(root, 'data/orders.csv'), 'utf8'), 'a,b\n1,2\n')
})

test('HOLE 3: a hard link to the run description itself is refused', (t) => {
  const { directory, root } = prepared(t)
  const out = join(directory, 'manifest.json')
  linkSync(join(root, 'run.json'), out)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inode/)
  assert.match(readFileSync(join(root, 'run.json'), 'utf8'), /edilec\.etl-run\/v1/)
})

test('HOLE 3: a hard link to a file this run RESOLVED but never opened is refused', (t) => {
  // The input set is every path the tool stats, lists or reasons about -- not
  // only the ones it opens. With the byte bound at 1, the input is stat-ed and
  // skipped without ever being opened; it is still an input.
  const { directory, root } = prepared(t)
  const out = join(directory, 'manifest.json')
  linkSync(join(root, 'data/orders.csv'), out)

  const result = attemptWrite(root, out, ['--max-file-bytes', '1'])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inode/)
  assert.equal(readFileSync(join(root, 'data/orders.csv'), 'utf8'), 'a,b\n1,2\n')
})

test('HOLE 3: the hard link is refused however far outside the root it sits', (t) => {
  const { directory, root } = prepared(t)
  const elsewhere = join(directory, 'elsewhere')
  mkdirSync(elsewhere)
  const out = join(elsewhere, 'manifest.json')
  linkSync(join(root, 'out/orders.tsv'), out)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(readFileSync(join(root, 'out/orders.tsv'), 'utf8'), 'a\tb\n1\t2\n')
})

test('HOLE 4: a one-hop dangling named input cannot become a fresh manifest', (t) => {
  const { directory, root } = prepared(t)
  const input = join(root, 'data/orders.csv')
  const out = join(directory, 'manifest-new.json')
  unlinkSync(input)
  symlinkSync('../../manifest-new.json', input)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(existsSync(out), false)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /names an input path/)
  assert.throws(() => readFileSync(input), { code: 'ENOENT' })
})

test('HOLE 4: a two-hop dangling named input cannot become a fresh manifest', (t) => {
  const { directory, root } = prepared(t)
  const input = join(root, 'data/orders.csv')
  const middle = join(root, 'middle.csv')
  const out = join(directory, 'manifest-new.json')
  unlinkSync(input)
  symlinkSync('../middle.csv', input)
  symlinkSync('../manifest-new.json', middle)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(existsSync(out), false)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /names an input path/)
  assert.throws(() => readFileSync(input), { code: 'ENOENT' })
})

test('ALLOWED: a distinct missing named input still permits an incomplete manifest', (t) => {
  const { directory, root } = prepared(t)
  const input = join(root, 'data/orders.csv')
  const out = join(directory, 'manifest-new.json')
  unlinkSync(input)
  symlinkSync('../../unrelated-missing.csv', input)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  assert.match(readFileSync(out, 'utf8'), /"edilec\.etl-manifest\/v1"/)
  assert.throws(() => readFileSync(input), { code: 'ENOENT' })
})

test('a destination that is a directory is refused', (t) => {
  const { directory, root } = prepared(t)
  const out = join(directory, 'somewhere')
  mkdirSync(out)
  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a regular file/)
})

test('a destination in a directory that does not exist is refused, and nothing is created', (t) => {
  const { directory, root } = prepared(t)
  const out = join(directory, 'missing', 'manifest.json')
  const result = attemptWrite(root, out)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /directory that does not exist/)
  assert.equal(existsSync(join(directory, 'missing')), false, 'the tool never creates a directory')
})

test('ALLOWED: a fresh path in an existing directory is written', (t) => {
  const { directory, root } = prepared(t)
  const out = join(directory, 'manifest.json')
  const result = attemptWrite(root, out)
  assert.equal(result.status, 0)
  assert.ok(result.stdout.startsWith('{'))
  assert.match(readFileSync(out, 'utf8'), /"edilec\.etl-manifest\/v1"/)
})

test('ALLOWED: an existing regular file that is not an input is overwritten', (t) => {
  const { directory, root } = prepared(t)
  const out = join(directory, 'manifest.json')
  writeFileSync(out, 'an older manifest\n', 'utf8')
  const result = attemptWrite(root, out)
  assert.equal(result.status, 0)
  assert.match(readFileSync(out, 'utf8'), /"edilec\.etl-manifest\/v1"/)
})

test('ALLOWED and DOCUMENTED: a symbolically linked parent directory is followed', (t) => {
  const { directory, root } = prepared(t)
  const real = join(directory, 'real-output-dir')
  mkdirSync(real)
  const link = join(directory, 'link-to-output-dir')
  symlinkSync(real, link)

  const result = attemptWrite(root, join(link, 'manifest.json'))
  assert.equal(result.status, 0, 'this tool declares no confinement root for --out')
  assert.match(readFileSync(join(real, 'manifest.json'), 'utf8'), /"edilec\.etl-manifest\/v1"/)
})

test('the help text says the destination is unconfined rather than claiming a confinement', () => {
  const help = runCli(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /NOT confined to --root/)
  assert.match(help.stdout, /symbolically linked parent directory is followed/)
})

test('recording twice over the same destination is a normal, allowed operation', (t) => {
  const { root } = prepared(t)
  const first = record(root)
  assert.equal(first.status, 0)
  const before = readFileSync(first.manifestPath, 'utf8')
  const second = record(root)
  assert.equal(second.status, 0)
  assert.equal(readFileSync(second.manifestPath, 'utf8'), before, 'the same run records the same bytes')
  assert.equal(statSync(second.manifestPath).isFile(), true)
})

/**
 * A destination the guard accepted, that the write then refuses.
 *
 * The guard answers "is this the file you meant"; it cannot answer "will the
 * kernel let you write it". Left uncaught the write failure is a Node stack
 * trace carrying absolute host paths, empty stdout and exit 1 -- which this
 * contract reads as "the check completed and the policy failed", so a consumer
 * would take a permission error for a digest mismatch.
 *
 * Root can write through any mode bit, so these two cases cannot be constructed
 * as root and say so rather than passing vacuously.
 */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('a destination that exists but cannot be written is exit 2, not a stack trace', (t) => {
  if (asRoot) return t.skip('mode bits do not refuse root')
  const { directory, root } = prepared(t)
  const out = join(directory, 'manifest.json')
  writeFileSync(out, 'an older manifest\n', 'utf8')
  chmodSync(out, 0o444)

  const result = attemptWrite(root, out)
  assert.equal(result.status, 2, 'an unusable destination is the configuration shape, never exit 1')
  assert.equal(result.stdout, '', 'a consumer piping stdout must not receive a report for a run that wrote nothing')
  assert.equal(result.stderr, 'etl-run-manifest: --out could not be written (EACCES)\n')
  assert.ok(!result.stderr.includes('at async'), 'no stack trace')
  assert.ok(!result.stderr.includes(ROOT), 'the absolute path of the tool itself never reaches stderr')
  assert.equal(readFileSync(out, 'utf8'), 'an older manifest\n', 'the destination is left as it was')
})

test('a destination that cannot even be inspected is refused, and says so', (t) => {
  // lstat is the first thing the guard does, and it can fail for a reason that
  // is not "no such file": a parent directory nobody may search. Without its
  // own refusal the run falls through to the "directory does not exist" branch,
  // which is a different and untrue statement about the destination.
  if (asRoot) return t.skip('mode bits do not refuse root')
  const { directory, root } = prepared(t)
  const sealed = join(directory, 'sealed')
  mkdirSync(sealed)
  chmodSync(sealed, 0o000)
  const result = attemptWrite(root, join(sealed, 'manifest.json'))
  chmodSync(sealed, 0o755)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'etl-run-manifest: --out could not be inspected: EACCES\n')
})

test('a destination in a directory that cannot be written is exit 2 as well', (t) => {
  if (asRoot) return t.skip('mode bits do not refuse root')
  const { directory, root } = prepared(t)
  const locked = join(directory, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o555)

  const result = attemptWrite(root, join(locked, 'manifest.json'))
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^etl-run-manifest: --out could not be written \(EACCES\)\n$/)
  assert.equal(existsSync(join(locked, 'manifest.json')), false)
})
