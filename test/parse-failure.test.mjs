/**
 * The parse-failure helper.
 *
 * V8 embeds raw input in its parse error message, so the message is untrusted
 * content and this helper is the only thing between a malformed document and
 * the report. The branch ORDER is the whole guard: a helper that looks for
 * `at position N` before recognising the quoting shape finds that text inside
 * the quoted span whenever the document itself contains it, and slices the
 * document straight back out.
 *
 * Nineteen of thirty-eight tools in this catalog shipped that bug. Every group
 * that wrote this test found it; the ones that applied the sketch verbatim did
 * not. The test is what finds it, not the review.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { UNPARSEABLE, parseFailureDetail } from '../src/parse-failure.mjs'
import { record, ruleIds, runDescription, runJson, temporary, tree, write, writeRun } from './support.mjs'

function failureFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error('that document parsed')
}

test('a document whose own text reads "at position 1" does not come back out', () => {
  const { message, detail } = failureFor('at position 1')
  assert.match(message, /"at position 1"/, 'V8 quotes the document, which is the trap')
  assert.equal(detail, "unexpected token 'a' at the start of the document")
  assert.ok(!detail.includes('at position 1'))
})

test('a document that is nothing but a credential is never reproduced', () => {
  const { message, detail } = failureFor('not-a-real-secret-0000')
  assert.match(message, /not-a-real-/)
  assert.equal(detail, "unexpected token 'o' at the start of the document")
  assert.ok(!detail.includes('not-a-real'))
})

test('a long document whose quoted window falls on a sensitive span is never reproduced', () => {
  const { message, detail } = failureFor('["not-a-real-secret-3333", ZQXJVBMP7W]')
  assert.match(message, /et-3333/, 'the window is taken from the offence, not from the start')
  assert.equal(detail, "unexpected token 'Z' inside the document")
  assert.ok(!detail.includes('3333'))
  assert.ok(!detail.includes('ZQXJVBMP7W'))
})

test('a quoted span containing a newline is still recognised (the s flag)', () => {
  const { message, detail } = failureFor('[\n"line one",\nZQXJVBMP7W\n]')
  assert.ok(message.includes('\n'), 'the quoted span really does carry a newline')
  assert.equal(detail, "unexpected token 'Z' inside the document")
  assert.ok(!detail.includes('line one'))
})

test('the safe positional form still yields its position', () => {
  const { message, detail } = failureFor('{"a": 1 "b": 2}')
  assert.match(message, /at position 8/)
  assert.equal(detail, "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)")
})

test('"Unexpected end of JSON input" is kept verbatim: it quotes nothing', () => {
  const { message, detail } = failureFor('{"a":')
  assert.equal(message, 'Unexpected end of JSON input')
  assert.equal(detail, 'Unexpected end of JSON input')
})

test('the backstop refuses any message that still carries a double quote', () => {
  // A wording this helper has never been taught. Across 500,206 distinct V8
  // parse messages, a surviving double quote always meant a surviving snippet.
  const invented = { message: 'Some future wording about "not-a-real-secret-4444" that nobody taught this helper' }
  assert.equal(parseFailureDetail(invented), UNPARSEABLE)
})

test('a message with no quote and no position falls back to the generic sentence', () => {
  assert.equal(parseFailureDetail({ message: 'something else entirely' }), UNPARSEABLE)
  assert.equal(parseFailureDetail(undefined), UNPARSEABLE)
})

test('the CLI reports an unparseable run description without echoing it', (t) => {
  const directory = temporary(t)
  tree(directory)
  write(directory, 'run.json', '["not-a-real-secret-5555", ZQXJVBMP7W]')
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.status, 'incomplete')
  assert.deepEqual(recorded.report.findings.map((finding) => finding.ruleId), ['run-description-unreadable'])
  assert.match(recorded.report.findings[0].message, /unexpected token 'Z' inside the document/)
  assert.ok(!recorded.stdout.includes('5555'))
  assert.ok(!recorded.stderr.includes('5555'))
})

test('the CLI reports an unparseable manifest without echoing it', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription())
  write(directory, 'broken.json', 'at position 1')
  const verified = runJson(['verify', '--root', directory, '--manifest', `${directory}/broken.json`, '--quiet'])
  assert.equal(verified.status, 2)
  assert.deepEqual(verified.report.findings.map((finding) => finding.ruleId), ['manifest-unreadable'])
  assert.match(verified.report.findings[0].message, /at the start of the document/)
  assert.ok(!verified.report.findings[0].message.includes('at position 1'))
})

/**
 * Bytes that are not UTF-8 are refused by the DECODER, not inferred afterwards.
 *
 * `fatal: true` is the guard. Decoding leniently turns an undecodable byte into
 * U+FFFD, and U+FFFD is a character a document may legally contain -- so the
 * document then parses, the replacement character travels into an identifier,
 * and a manifest is recorded for a run description nobody could read. The
 * decoder decides; the decoded text never gets a vote.
 */
function withInvalidUtf8(directory, name) {
  const description = runDescription({ runId: 'run-REPLACE-ME' })
  const text = `${JSON.stringify(description, null, 2)}\n`
  const bytes = Buffer.from(text, 'utf8')
  const index = bytes.indexOf(Buffer.from('REPLACE-ME', 'utf8'))
  bytes[index] = 0xff
  const target = join(directory, name)
  writeFileSync(target, bytes)
  return target
}

test('a run description that is not valid UTF-8 is refused, and nothing is recorded', (t) => {
  const directory = temporary(t)
  tree(directory)
  withInvalidUtf8(directory, 'run.json')

  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.status, 'incomplete')
  assert.deepEqual(ruleIds(recorded.report), ['run-description-unreadable'])
  assert.equal(recorded.report.findings[0].message, 'the run description is not valid UTF-8')
  assert.equal(recorded.report.summary.checked, 0)
  assert.ok(!recorded.stdout.includes('\uFFFD'), 'no replacement character reaches the report')
})

test('a manifest that is not valid UTF-8 is refused the same way', (t) => {
  const directory = temporary(t)
  tree(directory)
  const broken = withInvalidUtf8(directory, 'broken-manifest.json')
  const verified = runJson(['verify', '--root', directory, '--manifest', broken, '--quiet'])
  assert.equal(verified.status, 2)
  assert.deepEqual(ruleIds(verified.report), ['manifest-unreadable'])
  assert.equal(verified.report.findings[0].message, 'the manifest is not valid UTF-8')
})
