/**
 * One canonical serialisation, used for the manifest file on disk AND for the
 * integrity digest computed over it.
 *
 * They must be the same function. Two serialisers -- one that writes and one
 * that digests -- is the "two functions look at one value" shape that has
 * produced defects elsewhere in this catalog: the digest ends up covering a
 * rendering nobody ever sees.
 *
 * Object keys are ordered by UTF-16 code unit, so the bytes do not depend on
 * insertion order, on a hash map, or on the machine.
 */

import { byCodeUnit } from './text.mjs'

/** Deeper than any manifest this tool builds; a guard against a cyclic value. */
export const MAX_DEPTH = 16

function encode(value, indent, depth, pad) {
  if (depth > MAX_DEPTH) throw new TypeError(`value nests deeper than ${MAX_DEPTH} levels`)
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('a non-finite number has no canonical form')
    return JSON.stringify(value)
  }
  if (kind === 'string') return JSON.stringify(value)
  const nextPad = pad + ' '.repeat(indent)
  const open = indent === 0 ? '' : `\n${nextPad}`
  const close = indent === 0 ? '' : `\n${pad}`
  const join = indent === 0 ? ',' : `,\n${nextPad}`
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const parts = value.map((item) => encode(item, indent, depth + 1, nextPad))
    return `[${open}${parts.join(join)}${close}]`
  }
  if (kind === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(byCodeUnit)
    if (keys.length === 0) return '{}'
    const gap = indent === 0 ? ':' : ': '
    const parts = keys.map((key) => `${JSON.stringify(key)}${gap}${encode(value[key], indent, depth + 1, nextPad)}`)
    return `{${open}${parts.join(join)}${close}}`
  }
  throw new TypeError(`a value of type ${kind} has no canonical form`)
}

/** The compact canonical form. This is what gets digested. */
export function canonicalJson(value) {
  return encode(value, 0, 0, '')
}

/** The same ordering, indented, with a trailing newline. This is what gets written. */
export function canonicalDocument(value) {
  return `${encode(value, 2, 0, '')}\n`
}
