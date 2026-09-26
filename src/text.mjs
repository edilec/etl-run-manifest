/**
 * Text primitives: ordering, strict decoding, sanitisation and bounded excerpts.
 *
 * A run description is a document somebody exported. Every identifier, path,
 * parameter name and parameter value in it was chosen by something other than
 * the person reading the report, so all of it passes through here before it
 * reaches a report, a manifest or a human summary.
 *
 * Nothing in this module reads the filesystem, the clock, the locale, the
 * environment or the network.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both consult ICU data that differs
 * between Node builds, so either one lets two correct machines disagree about
 * the order of the same findings. A source grep for `.localeCompare(` does not
 * defend this -- substituting `Intl.Collator` produces identical collation
 * drift with different source text -- so `test/ordering.test.mjs` drives values
 * whose collated order genuinely differs from their code-unit order through the
 * real report path and pins the emitted order.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the point. Decoding leniently and then looking for U+FFFD in
 * the result cannot tell undecodable bytes apart from a document that legally
 * contains a replacement character. The decoder decides; the decoded text never
 * gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * The characters removed from every document-derived string on its way out.
 *
 * Built from code points rather than written literally: a raw U+2028 inside a
 * module is a syntax hazard, and the whole point of the class is that these
 * characters never reach a line a person reads.
 *
 * - C0 (U+0000-U+001F) and DEL (U+007F): a bare newline forges a whole row of
 *   the human summary; the rest drive a terminal. Tab and newline are included
 *   deliberately -- no identifier, path or parameter value in this schema has a
 *   legitimate use for either, and the human summary is one line per finding.
 * - C1 (U+0080-U+009F): U+0085 (NEL) begins a new line on a terminal exactly as
 *   a newline does and U+009B is the 8-bit CSI. Neither is ECMAScript
 *   whitespace and neither is escaped by `JSON.stringify`, so a class that
 *   stops at C0 lets both through.
 * - U+2028 / U+2029: they terminate a line for a JavaScript consumer.
 * - Bidi controls (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses displayed text, so a manifest naming one file reads as another,
 *   and the isolates hide what they wrap.
 *
 * This applies to run identifiers, dataset identifiers, paths, parameter names
 * and parameter values -- not only to an excerpt field.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}`
  + `${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'gu',
)

/**
 * Remove the control class.
 *
 * Only a string may be sanitised. `String(value)` THROWS for an object whose
 * `toString` is not callable, and a sanitisation boundary that throws is a
 * boundary that turns a bad document into a stack trace, so the type is checked
 * here rather than trusted from the caller.
 */
export function sanitise(value) {
  if (typeof value !== 'string') throw new TypeError('sanitise() takes a string')
  return value.replace(CONTROL, '')
}

/**
 * The rendered form of a string field, or `null` when there is nothing to
 * render.
 *
 * `value.trim().length > 0` is the check this replaces, and it is wrong: `trim`
 * removes ECMAScript whitespace only, so a field of U+0001 or U+200E passes it
 * and then renders as the empty string. Whatever decides "is this present and
 * usable" must be asked about the form that will actually be emitted.
 */
export function renderable(value) {
  if (typeof value !== 'string') return null
  const rendered = sanitise(value)
  return rendered.length === 0 ? null : rendered
}

/** A type name for a diagnostic, obtained without stringifying the value. */
export function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** True for a non-null, non-array object literal. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The bound on any one document-derived string reproduced in a finding. */
export const EXCERPT_LIMIT = 160

/** A sanitised, length-bounded excerpt. Never used for a parameter value. */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const rendered = typeof value === 'string' ? sanitise(value) : ''
  if (rendered.length <= limit) return rendered
  return `${rendered.slice(0, limit)}...`
}
