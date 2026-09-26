/**
 * Load one manifest and say whether it still matches its own integrity digest.
 *
 * The digest is recomputed from the RAW parsed document rather than from the
 * compiled one, because the compiled form is the tool's reading of the document
 * and a digest over a reading proves nothing about the bytes somebody stored.
 */

import { canonicalJson } from './canonical.mjs'
import { digestText, readJsonDocument } from './files.mjs'
import { LIMITS } from './limits.mjs'
import { compileManifest } from './schema.mjs'

export async function loadManifest(absolutePath, label, report, limits = LIMITS) {
  const document = await readJsonDocument(absolutePath, limits)
  if (!document.ok) {
    report.add('manifest-unreadable', { file: label, message: `the manifest ${document.detail}` })
    return { ok: false }
  }
  const compiled = compileManifest(document.value, limits)
  if (!compiled.ok) {
    for (const problem of compiled.problems) {
      report.add('manifest-invalid', {
        file: label,
        pointer: problem.pointer === '' ? '/' : problem.pointer,
        message: `${problem.pointer === '' ? 'the document' : problem.pointer} ${problem.message}`,
      })
    }
    return { ok: false }
  }
  const raw = document.value
  const recomputed = digestText(canonicalJson({ schema: raw.schema, tool: raw.tool, run: raw.run }))
  const intact = recomputed === compiled.manifest.integrity.digest
  if (!intact) {
    report.add('manifest-integrity-mismatch', {
      file: label,
      pointer: '/integrity/digest',
      message:
        'the manifest does not match the integrity digest it carries, so its recorded digests are not evidence '
        + 'about the run it names',
      suggestion: 'record the run again rather than repairing the manifest by hand',
    })
  }
  return { ok: true, run: compiled.manifest.run, intact }
}
