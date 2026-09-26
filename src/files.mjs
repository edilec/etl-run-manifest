/**
 * Reading documents and hashing declared files, under the declared bounds and
 * inside the declared root.
 *
 * Path confinement here is not lexical. Rejecting "../" and absolute paths is
 * what a tool in this catalog did before a symlink planted inside its root was
 * followed out of the tree and out-of-root content was echoed into the report.
 * The REAL path is resolved and asserted to be inside the REAL root.
 *
 * Every bound is checked before the work: a document's size is read from `stat`
 * before its bytes are, and a file's size is read from `stat` before it is
 * opened. The streaming loop counts bytes as well, because a file can grow
 * between the two.
 */

import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { LIMITS } from './limits.mjs'
import { parseFailureDetail } from './parse-failure.mjs'
import { decodeUtf8 } from './text.mjs'

export const DIGEST_ALGORITHM = 'sha256'
const CHUNK_BYTES = 65536

/** Resolve the real root once, so every later comparison is against a real path. */
export async function resolveRoot(root) {
  return realpath(resolve(root))
}

/**
 * Read and parse one JSON document.
 *
 * Never returns the document text on failure: `parseFailureDetail` exists
 * because V8 embeds raw input in its parse error message.
 */
export async function readJsonDocument(absolutePath, limits = LIMITS) {
  let info
  try {
    info = await stat(absolutePath)
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: `could not be opened (${error.code ?? 'unknown error'})` }
  }
  if (!info.isFile()) return { ok: false, reason: 'unreadable', detail: 'is not a regular file' }
  if (info.size > limits.maxDocumentBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `is ${info.size} bytes, over the document limit of ${limits.maxDocumentBytes}`,
    }
  }
  let bytes
  let handle
  try {
    handle = await open(absolutePath, 'r')
    bytes = await handle.readFile()
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: `could not be read (${error.code ?? 'unknown error'})` }
  } finally {
    await handle?.close()
  }
  if (bytes.byteLength > limits.maxDocumentBytes) {
    return {
      ok: false,
      reason: 'too-large',
      detail: `is ${bytes.byteLength} bytes, over the document limit of ${limits.maxDocumentBytes}`,
    }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) return { ok: false, reason: 'not-utf8', detail: 'is not valid UTF-8' }
  try {
    return { ok: true, value: JSON.parse(decoded.text) }
  } catch (error) {
    return { ok: false, reason: 'not-json', detail: parseFailureDetail(error) }
  }
}

/**
 * Hash one declared file.
 *
 * Returns either `{ digest, bytes, resolved }` or `{ unresolved, detail }`.
 * `unresolved` is the honest answer and it is never a digest: a file this run
 * could not read has no evidence, and a manifest entry with no digest says so
 * rather than leaving the entry out. A gap in a manifest reads as "no such
 * input"; an entry marked unresolved reads as what it is.
 *
 * `touched` is always returned, resolved or not, because every path this tool
 * stats belongs in the set the destination guard compares against.
 */
export async function hashFile(realRoot, relativePath, limits = LIMITS) {
  const joined = resolve(realRoot, relativePath)
  let real
  try {
    real = await realpath(joined)
  } catch (error) {
    return {
      unresolved: error.code === 'ENOENT' ? 'not-found' : 'unreadable',
      detail: `could not be resolved (${error.code ?? 'unknown error'})`,
      touched: [joined],
    }
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return {
      unresolved: 'outside-root',
      detail: 'resolves outside the declared root, so its bytes are not evidence about this root',
      touched: [joined, real],
    }
  }
  const touched = [joined, real]
  let info
  try {
    info = await stat(real)
  } catch (error) {
    return { unresolved: 'unreadable', detail: `could not be inspected (${error.code ?? 'unknown error'})`, touched }
  }
  if (!info.isFile()) return { unresolved: 'not-a-file', detail: 'is not a regular file', touched }
  if (info.size > limits.maxFileBytes) {
    return {
      unresolved: 'too-large',
      detail: `is ${info.size} bytes, over the file limit of ${limits.maxFileBytes}`,
      touched,
    }
  }

  const hash = createHash(DIGEST_ALGORITHM)
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  let total = 0
  let handle
  try {
    handle = await open(real, 'r')
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > limits.maxFileBytes) {
        return {
          unresolved: 'too-large',
          detail: `grew past the file limit of ${limits.maxFileBytes} bytes while it was being read`,
          touched,
        }
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
  } catch (error) {
    return { unresolved: 'unreadable', detail: `could not be read (${error.code ?? 'unknown error'})`, touched }
  } finally {
    await handle?.close()
  }
  return { digest: hash.digest('hex'), bytes: total, touched }
}

/** The digest of an in-memory canonical string, used for manifest integrity. */
export function digestText(text) {
  return createHash(DIGEST_ALGORITHM).update(Buffer.from(text, 'utf8')).digest('hex')
}
