/**
 * `record`: read a run description, hash everything it names, and write one
 * manifest.
 *
 * What is NOT here is as much of the design as what is. There is no clock read,
 * so nothing in the manifest is stamped by this tool -- `recordedAt` is an
 * opaque label the run description supplies, and it is copied, never parsed. A
 * timestamp minted here would make two recordings of one run differ, which is
 * the opposite of what a manifest is for.
 *
 * There is no environment read either. A credential is named in `secretRefs`
 * and its value is never fetched, so there is no value to leave out.
 */

import { MANIFEST_SCHEMA, compileRunDescription } from './schema.mjs'
import { byCodeUnit } from './text.mjs'
import { canonicalDocument, canonicalJson } from './canonical.mjs'
import { DIGEST_ALGORITHM, digestText, hashFile, readJsonDocument } from './files.mjs'
import { LIMITS } from './limits.mjs'
import { ReportBuilder, TOOL_ID } from './report.mjs'

export const RUN_LABEL = '(run description)'
export const MANIFEST_LABEL = '(manifest)'

/** The paths a run description names, joined to the root, before anything is read. */
export function declaredPaths(run) {
  const paths = []
  for (const entry of run.transformation?.code ?? []) if (entry.path !== null) paths.push(entry.path)
  for (const entry of run.inputs) if (entry.path !== null) paths.push(entry.path)
  for (const entry of run.outputs) if (entry.path !== null) paths.push(entry.path)
  return paths
}

async function hashAll(entries, realRoot, limits, report, pointerBase, withId) {
  const recorded = []
  const touched = []
  let resolved = 0
  let unresolved = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const result = await hashFile(realRoot, entry.path, limits)
    touched.push(...result.touched)
    if (result.unresolved === undefined) {
      resolved += 1
      recorded.push(withId
        ? { id: entry.id, path: entry.path, digest: result.digest, bytes: result.bytes, unresolved: null }
        : { path: entry.path, digest: result.digest, bytes: result.bytes, unresolved: null })
      continue
    }
    unresolved += 1
    const ruleId = result.unresolved === 'too-large'
      ? 'file-too-large'
      : result.unresolved === 'outside-root'
        ? 'path-outside-root'
        : 'file-unreadable'
    report.add(ruleId, {
      file: entry.path,
      pointer: `${pointerBase}/${index}`,
      message: `${entry.path} ${result.detail}, so this manifest records no digest for it`,
      suggestion: 'record the run again once the file is readable; an entry with no digest is not evidence',
    })
    recorded.push(withId
      ? { id: entry.id, path: entry.path, digest: null, bytes: null, unresolved: result.unresolved }
      : { path: entry.path, digest: null, bytes: null, unresolved: result.unresolved })
  }
  // Sorted by the key the manifest is later compared on, so two run descriptions
  // that declare the same files in a different order record the same manifest --
  // and therefore the same integrity digest. Declaration order is not evidence.
  recorded.sort((left, right) => byCodeUnit(withId ? left.id : left.path, withId ? right.id : right.path))
  return { recorded, touched, resolved, unresolved }
}

/**
 * Build the manifest for one run description.
 *
 * `realRoot` is already resolved by the caller; `runPath` is absolute. The
 * caller has already cleared the destination, because the destination guard
 * needs the declared path set and that set is only known once the run
 * description compiles.
 */
export async function recordRun({ runPath, realRoot, limits = LIMITS }) {
  const report = new ReportBuilder(limits)
  const document = await readJsonDocument(runPath, limits)
  if (!document.ok) {
    report.add('run-description-unreadable', {
      file: RUN_LABEL,
      message: `the run description ${document.detail}`,
    })
    return { report: report.finish({ checked: 0, recorded: 0, unresolved: 0 }), manifest: null, document: null, touched: [] }
  }
  const compiled = compileRunDescription(document.value, limits)
  if (!compiled.ok) {
    for (const problem of compiled.problems) {
      report.add('run-description-invalid', {
        file: RUN_LABEL,
        pointer: problem.pointer === '' ? '/' : problem.pointer,
        message: `${problem.pointer === '' ? 'the document' : problem.pointer} ${problem.message}`,
      })
    }
    return { report: report.finish({ checked: 0, recorded: 0, unresolved: 0 }), manifest: null, document: null, touched: [] }
  }

  const run = compiled.run
  const code = await hashAll(run.transformation.code, realRoot, limits, report, '/transformation/code', false)
  const inputs = await hashAll(run.inputs, realRoot, limits, report, '/inputs', true)
  const outputs = await hashAll(run.outputs, realRoot, limits, report, '/outputs', true)
  const checked = code.recorded.length + inputs.recorded.length + outputs.recorded.length

  if (checked === 0) {
    report.add('no-evidence-recorded', {
      file: RUN_LABEL,
      message:
        'this run description names no input, no output and no code file, so a manifest built from it would '
        + 'assert nothing about anything',
      suggestion: 'name at least one file; a manifest of nothing is not a green run',
    })
  }

  const body = {
    schema: MANIFEST_SCHEMA,
    tool: TOOL_ID,
    run: {
      runId: run.runId,
      recordedAt: run.recordedAt,
      parentRunIds: [...run.parentRunIds].sort(byCodeUnit),
      transformation: { id: run.transformation.id, version: run.transformation.version, code: code.recorded },
      seed: run.seed,
      parameters: [...run.parameters].sort((left, right) => byCodeUnit(left.name, right.name)),
      secretRefs: [...run.secretRefs].sort((left, right) => byCodeUnit(left.name, right.name)),
      inputs: inputs.recorded,
      outputs: outputs.recorded,
    },
  }
  const manifest = { ...body, integrity: { algorithm: DIGEST_ALGORITHM, digest: digestText(canonicalJson(body)) } }
  const touched = [...code.touched, ...inputs.touched, ...outputs.touched]

  // Bound the artefact, not only the inputs. Every documented per-run bound can
  // be respected -- 512 inputs, 256 outputs, 128 code files, ids and paths
  // inside their character limits -- and still produce a manifest larger than
  // the document limit that `verify` and `compare` read manifests under. Such a
  // manifest is written once and refused for ever after, which is the opposite
  // of a record worth having, so it is not written at all and the limit is
  // named. The bound is the same `maxDocumentBytes` both readers apply, so what
  // this writes is by construction something it can read back.
  const manifestDocument = canonicalDocument(manifest)
  const documentBytes = Buffer.byteLength(manifestDocument, 'utf8')
  if (documentBytes > limits.maxDocumentBytes) {
    report.add('manifest-too-large', {
      file: MANIFEST_LABEL,
      pointer: '/run',
      message:
        `the manifest for run "${run.runId}" would be ${documentBytes} bytes, over the document limit of `
        + `${limits.maxDocumentBytes} that verify and compare read a manifest under, so it was not written`,
      suggestion: 'record fewer files in one run, or raise --max-document-bytes for this run and every later read',
    })
    return {
      report: report.finish({
        checked,
        recorded: code.resolved + inputs.resolved + outputs.resolved,
        unresolved: code.unresolved + inputs.unresolved + outputs.unresolved,
      }),
      manifest: null,
      document: null,
      touched,
    }
  }

  report.add('manifest-recorded', {
    file: MANIFEST_LABEL,
    pointer: '/integrity/digest',
    message:
      `manifest for run "${run.runId}" records ${inputs.resolved} of ${inputs.recorded.length} input digest(s), `
      + `${outputs.resolved} of ${outputs.recorded.length} output digest(s) and `
      + `${code.resolved} of ${code.recorded.length} code digest(s); integrity ${DIGEST_ALGORITHM} `
      + `${manifest.integrity.digest}`,
  })

  return {
    report: report.finish({
      checked,
      recorded: code.resolved + inputs.resolved + outputs.resolved,
      unresolved: code.unresolved + inputs.unresolved + outputs.unresolved,
    }),
    manifest,
    document: manifestDocument,
    touched,
  }
}
