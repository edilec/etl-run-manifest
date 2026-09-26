/**
 * `verify`: re-hash what a manifest recorded and say whether it still holds.
 *
 * This is the half of the tool that makes the other half worth having.
 * Changing one byte of a recorded input changes its digest, and a digest that
 * no longer matches is a failure -- the manifest's claim about that input has
 * been invalidated, and the run it describes can no longer be said to have had
 * that input.
 *
 * An entry the manifest recorded WITHOUT a digest is not verified and is not
 * quietly skipped either. It is reported, and it makes the whole verification
 * incomplete: the entries that do have digests are still checked and counted,
 * but a manifest holding an entry that was never hashed has not been verified,
 * whatever the rest of it says.
 */

import { hashFile } from './files.mjs'
import { LIMITS } from './limits.mjs'
import { loadManifest } from './load.mjs'
import { ReportBuilder } from './report.mjs'

export const MANIFEST_LABEL = '(manifest)'

const MISMATCH_RULE = Object.freeze({
  input: 'input-digest-mismatch',
  output: 'output-digest-mismatch',
  code: 'code-digest-mismatch',
})

function unresolvedRule(reason) {
  if (reason === 'too-large') return 'file-too-large'
  if (reason === 'outside-root') return 'path-outside-root'
  return 'file-unreadable'
}

async function verifyGroup(entries, kind, pointerBase, realRoot, limits, report, counts) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const pointer = `${pointerBase}/${index}`
    counts.checked += 1
    if (entry.digest === null) {
      counts.unresolved += 1
      report.add('digest-unresolved', {
        file: entry.path,
        pointer,
        message:
          `the manifest recorded no digest for this ${kind} (${entry.unresolved ?? 'no reason given'}), `
          + 'so there is nothing to verify it against and this run is not verified',
        suggestion: 'record the run again once every file it names can be read',
      })
      continue
    }
    const result = await hashFile(realRoot, entry.path, limits)
    if (result.unresolved !== undefined) {
      counts.unresolved += 1
      report.add(unresolvedRule(result.unresolved), {
        file: entry.path,
        pointer,
        message: `${entry.path} ${result.detail}, so the digest the manifest records for it could not be checked`,
      })
      continue
    }
    if (result.digest !== entry.digest) {
      counts.mismatched += 1
      report.add(MISMATCH_RULE[kind], {
        file: entry.path,
        pointer,
        message:
          `${entry.path} now hashes to ${result.digest} and the manifest records ${entry.digest}, `
          + `so the evidence this manifest holds about this ${kind} is no longer valid`,
        suggestion: 'the file changed after the run was recorded; record a new run rather than editing the manifest',
      })
      continue
    }
    counts.verified += 1
  }
}

export async function verifyManifest({ manifestPath, realRoot, limits = LIMITS }) {
  const report = new ReportBuilder(limits)
  const loaded = await loadManifest(manifestPath, MANIFEST_LABEL, report, limits)
  if (!loaded.ok) {
    return report.finish({ checked: 0, verified: 0, mismatched: 0, unresolved: 0 })
  }
  const run = loaded.run
  const counts = { checked: 0, verified: 0, mismatched: 0, unresolved: 0 }
  await verifyGroup(run.transformation.code, 'code', '/run/transformation/code', realRoot, limits, report, counts)
  await verifyGroup(run.inputs, 'input', '/run/inputs', realRoot, limits, report, counts)
  await verifyGroup(run.outputs, 'output', '/run/outputs', realRoot, limits, report, counts)

  if (counts.checked === 0) {
    report.add('no-evidence-recorded', {
      file: MANIFEST_LABEL,
      pointer: '/run',
      message:
        'this manifest records no input, no output and no code file, so verifying it establishes nothing '
        + 'about the run it names',
    })
  } else if (counts.mismatched === 0 && counts.unresolved === 0 && loaded.intact) {
    report.add('verification-complete', {
      file: MANIFEST_LABEL,
      pointer: '/run',
      message:
        `all ${counts.verified} recorded file(s) for run "${run.runId}" hash to the digests the manifest records, `
        + 'and the manifest matches its own integrity digest',
    })
  }
  return report.finish(counts)
}
