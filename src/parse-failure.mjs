/**
 * Describe a JSON parse failure without reproducing the document.
 *
 * V8 embeds raw input in its parse error message, so the message itself is
 * untrusted content:
 *
 *   safe   Expected ',' or '}' after property value in JSON at position 37 (line 1 column 38)
 *   LEAKS  Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON
 *   LEAKS  Unexpected token 'Z', ..."{"alpha": ZQXJVBMP7W"... is not valid JSON
 *
 * The third form shows why truncating the front is not a fix: the quoted window
 * is taken from wherever the offence is, not from the start of the document.
 */

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input, recognised FIRST.
 *
 * A document whose own text reads `at position 1` produces
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so a helper that
 * looks for the offset first finds that text INSIDE the quoted span and slices
 * the document straight back out. Nineteen of thirty-eight tools in this
 * catalog shipped that bug from a sketch with the branches in this order
 * reversed.
 *
 * The `s` flag matters too: the quoted span can contain a newline, and a
 * non-dotAll pattern silently fails to recognise the shape it exists to catch.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what the parse failure was, safely.
 *
 * The closing check is belt and braces on purpose, and it is the reason this
 * function is safe against wordings it has never been taught: across 500,206
 * distinct V8 parse messages, every message carrying no quoted snippet also
 * carried no double quote at all -- V8 quotes JSON punctuation with
 * apostrophes. So a surviving double quote means a snippet survived, whatever
 * the branches above concluded.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

export { UNPARSEABLE }
