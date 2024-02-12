/**
 * The control-character class, tested by CLASS and through an IDENTIFIER.
 *
 * Four tools in this catalog stripped C0 and the line/paragraph separators and
 * let the C1 range through, so U+0085 (NEL) and U+009B (8-bit CSI) still forged
 * lines in a human report and U+202E still reversed displayed text. One
 * sanitised its evidence field carefully and let a page id containing a newline
 * forge whole lines.
 *
 * This tool REFUSES rather than strips, because stripping a character out of an
 * identifier or a path changes what it refers to. Either way the guarantee is
 * the same and it is asserted on the emitted bytes: nothing in this class ever
 * reaches stdout or stderr.
 *
 * No literal control character appears in this file: every one is built from
 * its code point.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { renderable, sanitise } from '../src/index.mjs'
import { record, ruleIds, runDescription, temporary, tree, writeRun } from './support.mjs'

const CLASSES = [
  { label: 'C0 U+0001', code: 0x01 },
  { label: 'C0 newline U+000A', code: 0x0a },
  { label: 'C0 tab U+0009', code: 0x09 },
  { label: 'DEL U+007F', code: 0x7f },
  { label: 'C1 NEL U+0085', code: 0x85 },
  { label: 'C1 CSI U+009B', code: 0x9b },
  { label: 'line separator U+2028', code: 0x2028 },
  { label: 'paragraph separator U+2029', code: 0x2029 },
  { label: 'bidi mark U+200E', code: 0x200e },
  { label: 'bidi override U+202E', code: 0x202e },
  { label: 'bidi isolate U+2066', code: 0x2066 },
]

for (const { label, code } of CLASSES) {
  test(`${label} arriving through an IDENTIFIER is refused, and never reaches the output`, (t) => {
    const directory = temporary(t)
    tree(directory)
    const character = String.fromCharCode(code)
    writeRun(directory, runDescription({ runId: `nightly${character}run` }))

    const recorded = record(directory)
    assert.equal(recorded.status, 2)
    assert.equal(recorded.report.status, 'incomplete')
    assert.deepEqual(ruleIds(recorded.report), ['run-description-invalid'])
    assert.equal(recorded.report.findings[0].location.pointer, '/runId')
    assert.match(recorded.report.findings[0].message, /control, bidi or line-separator character/)
    const forged = `nightly${character}run`
    assert.ok(!recorded.stdout.includes(forged), 'the identifier must not be reproduced on stdout')
    assert.ok(!recorded.stderr.includes(forged), 'the identifier must not be reproduced on stderr')
    if (code !== 0x0a) {
      // A newline is the one character the report legitimately emits, between
      // its own lines. Every other class must be absent outright.
      assert.ok(!recorded.stdout.includes(character), 'the character must not reach stdout')
      assert.ok(!recorded.stderr.includes(character), 'the character must not reach stderr')
    }
  })

  test(`${label} is removed by sanitise()`, () => {
    assert.equal(sanitise(`a${String.fromCharCode(code)}b`), 'ab')
  })
}

test('a parameter value carrying a control character is refused with its own pointer', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    parameters: [{ name: 'note', value: `before${String.fromCharCode(0x85)}after` }],
  }))
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.findings[0].location.pointer, '/parameters/0/value')
})

test('a path carrying a control character is refused rather than silently renamed', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory, runDescription({
    inputs: [{ id: 'orders_raw', path: `data/${String.fromCharCode(0x202e)}orders.csv` }],
  }))
  const recorded = record(directory)
  assert.equal(recorded.status, 2)
  assert.equal(recorded.report.findings[0].location.pointer, '/inputs/0/path')
  assert.match(recorded.report.findings[0].message, /would render as something else/)
})

test('renderable() answers about the RENDERED form, which trim() does not', () => {
  const onlyControls = `${String.fromCharCode(0x01)}${String.fromCharCode(0x200e)}`
  assert.equal(onlyControls.trim().length > 0, true, 'trim removes ECMAScript whitespace only')
  assert.equal(renderable(onlyControls), null)
  assert.equal(renderable('orders'), 'orders')
  assert.equal(renderable(''), null)
  assert.equal(renderable(7), null)
})

test('sanitise() refuses a non-string rather than calling String() on it', () => {
  // The message matters as much as the type. Without the check both of these
  // still throw a TypeError -- from `value.replace` not being a function -- so
  // an assertion on the type alone passes for a reason it was not written to
  // check, and the boundary that is supposed to refuse a bad value has quietly
  // become a boundary that trips over it.
  assert.throws(() => sanitise({ toString: {} }), { name: 'TypeError', message: 'sanitise() takes a string' })
  assert.throws(() => sanitise(null), { name: 'TypeError', message: 'sanitise() takes a string' })
  assert.throws(() => sanitise(42), { name: 'TypeError', message: 'sanitise() takes a string' })
})

test('no output character from a full run falls in the control class', (t) => {
  const directory = temporary(t)
  tree(directory)
  writeRun(directory)
  const recorded = record(directory, { args: [] })
  const newline = String.fromCharCode(0x0a)
  const forbidden = CLASSES.filter(({ code }) => code !== 0x0a).map(({ code }) => String.fromCharCode(code))
  const without = (text) => text.split(newline).join('')
  for (const character of forbidden) {
    assert.ok(!without(recorded.stdout).includes(character))
    assert.ok(!without(recorded.stderr).includes(character))
  }
})
