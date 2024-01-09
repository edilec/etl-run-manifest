/**
 * `compare`: decide whether two manifests describe the same run repeated.
 *
 * The rule this module exists to enforce: UNKNOWN IS NEVER A PASS ON EITHER
 * SIDE OF A COMPARISON.
 *
 * A manifest entry with no digest carries no evidence. Two such entries carry
 * no evidence twice. `null === null` is true in JavaScript and false about the
 * world, and a comparison that took it for agreement would report two runs as
 * reproductions of each other on the strength of two files neither run could
 * read. So every pairing checks for absence BEFORE it checks for equality, the
 * pair is reported as unresolved, and the whole comparison becomes incomplete.
 *
 * The same rule governs the positive verdicts. `runs-reproduced` and
 * `output-nondeterministic` are both POSITIVE claims -- one says the run
 * reproduced, the other says the transformation is not deterministic -- and
 * neither is emitted unless every field it rests on is known on both sides.
 * Outputs that differ while an input digest is missing is not evidence of
 * nondeterminism; it is evidence of nothing at all.
 *
 * Credentials are deliberately outside the determinism verdict. A manifest pins
 * the BYTES of every input, so a run reading the same bytes with a differently
 * named credential read the same data. The difference is recorded as lineage,
 * at info severity, and it is documented in the README rather than folded into
 * a claim about determinism.
 */

import { LIMITS } from './limits.mjs'
import { loadManifest } from './load.mjs'
import { ReportBuilder } from './report.mjs'
import { byCodeUnit } from './text.mjs'

export const BASELINE_LABEL = '(baseline)'
export const CANDIDATE_LABEL = '(candidate)'

/**
 * Index one side of a comparison by its key.
 *
 * `Map.set` keeps the last entry per key, so this is lossless only because
 * `compileManifest` refuses a manifest that repeats a dataset id, a code path,
 * a parameter name or a secret reference name -- both manifests are compiled
 * before anything here runs. Without that refusal a dropped entry would be
 * compared on nothing and still counted as agreeing.
 */
function keyed(entries, keyOf) {
  const map = new Map()
  for (const entry of entries) map.set(keyOf(entry), entry)
  return map
}

function unionKeys(left, right) {
  return [...new Set([...left.keys(), ...right.keys()])].sort(byCodeUnit)
}

function compareGroup({ baseline, candidate, keyOf, ruleId, kind, pointerBase, report, counts }) {
  const left = keyed(baseline, keyOf)
  const right = keyed(candidate, keyOf)
  const group = { equal: true, known: true }
  for (const key of unionKeys(left, right)) {
    const a = left.get(key)
    const b = right.get(key)
    counts.checked += 1
    const pointer = `${pointerBase}/${key}`
    if (a === undefined || b === undefined) {
      group.equal = false
      counts.differing += 1
      const side = a === undefined ? 'the candidate only' : 'the baseline only'
      report.add(ruleId, {
        file: a === undefined ? CANDIDATE_LABEL : BASELINE_LABEL,
        pointer,
        message: `the ${kind} "${key}" is recorded by ${side}, so these two runs did not use the same ${kind} set`,
      })
      continue
    }
    // Absence is checked BEFORE equality. Two missing digests are not a match.
    if (a.digest === null || b.digest === null) {
      group.known = false
      counts.unresolved += 1
      const which = a.digest === null && b.digest === null
        ? 'neither manifest'
        : a.digest === null ? 'the baseline' : 'the candidate'
      report.add('evidence-unresolved', {
        file: a.digest === null ? BASELINE_LABEL : CANDIDATE_LABEL,
        pointer,
        message:
          `${which} recorded a digest for the ${kind} "${key}", so this pair cannot be compared; `
          + 'two absent digests are not a match',
        suggestion: 'record both runs again once every file they name can be read',
      })
      continue
    }
    if (a.digest !== b.digest) {
      group.equal = false
      counts.differing += 1
      report.add(ruleId, {
        file: BASELINE_LABEL,
        pointer,
        message: `the ${kind} "${key}" hashes to ${a.digest} in the baseline and ${b.digest} in the candidate`,
      })
    }
  }
  return group
}

function describeValue(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}

function compareParameters(baseline, candidate, report, counts) {
  const left = keyed(baseline, (entry) => entry.name)
  const right = keyed(candidate, (entry) => entry.name)
  let equal = true
  for (const key of unionKeys(left, right)) {
    const a = left.get(key)
    const b = right.get(key)
    counts.checked += 1
    if (a === undefined || b === undefined) {
      equal = false
      counts.differing += 1
      report.add('parameters-differ', {
        file: a === undefined ? CANDIDATE_LABEL : BASELINE_LABEL,
        pointer: `/run/parameters/${key}`,
        message: `the parameter "${key}" is recorded by ${a === undefined ? 'the candidate only' : 'the baseline only'}`,
      })
      continue
    }
    if (a.value !== b.value) {
      equal = false
      counts.differing += 1
      report.add('parameters-differ', {
        file: BASELINE_LABEL,
        pointer: `/run/parameters/${key}`,
        message: `the parameter "${key}" was ${describeValue(a.value)} in the baseline and ${describeValue(b.value)} in the candidate`,
      })
    }
  }
  return equal
}

function compareSecretRefs(baseline, candidate, report) {
  const render = (entries) => entries.map((entry) => `${entry.name}@${entry.source}`).sort(byCodeUnit).join(', ')
  const a = render(baseline)
  const b = render(candidate)
  if (a === b) return
  report.add('secret-refs-differ', {
    file: BASELINE_LABEL,
    pointer: '/run/secretRefs',
    message:
      `the runs name different credentials (baseline: ${a === '' ? 'none' : a}; candidate: ${b === '' ? 'none' : b}); `
      + 'no credential value is recorded by either manifest, and this difference does not enter the determinism verdict '
      + 'because both manifests pin the input bytes directly',
  })
}

export async function compareManifests({ baselinePath, candidatePath, limits = LIMITS }) {
  const report = new ReportBuilder(limits)
  const baseline = await loadManifest(baselinePath, BASELINE_LABEL, report, limits)
  const candidate = await loadManifest(candidatePath, CANDIDATE_LABEL, report, limits)
  const counts = { checked: 0, differing: 0, unresolved: 0 }
  if (!baseline.ok || !candidate.ok) return report.finish(counts)

  const left = baseline.run
  const right = candidate.run

  let identityEqual = true
  if (left.transformation.id !== right.transformation.id) {
    identityEqual = false
    counts.differing += 1
    report.add('transformation-differs', {
      file: BASELINE_LABEL,
      pointer: '/run/transformation/id',
      message: `the baseline ran "${left.transformation.id}" and the candidate ran "${right.transformation.id}"`,
    })
  }
  if (left.transformation.version !== right.transformation.version) {
    identityEqual = false
    counts.differing += 1
    report.add('transformation-differs', {
      file: BASELINE_LABEL,
      pointer: '/run/transformation/version',
      message:
        `the baseline ran version "${left.transformation.version}" and the candidate ran version `
        + `"${right.transformation.version}"`,
    })
  }
  counts.checked += 2

  const code = compareGroup({
    baseline: left.transformation.code,
    candidate: right.transformation.code,
    keyOf: (entry) => entry.path,
    ruleId: 'transformation-differs',
    kind: 'code file',
    pointerBase: '/run/transformation/code',
    report,
    counts,
  })

  let seedEqual = true
  counts.checked += 1
  if (left.seed !== right.seed) {
    seedEqual = false
    counts.differing += 1
    report.add('seed-differs', {
      file: BASELINE_LABEL,
      pointer: '/run/seed',
      message: `the baseline seed was ${describeValue(left.seed)} and the candidate seed was ${describeValue(right.seed)}`,
    })
  }

  const parametersEqual = compareParameters(left.parameters, right.parameters, report, counts)
  compareSecretRefs(left.secretRefs, right.secretRefs, report)

  const inputs = compareGroup({
    baseline: left.inputs,
    candidate: right.inputs,
    keyOf: (entry) => entry.id,
    ruleId: 'inputs-differ',
    kind: 'input',
    pointerBase: '/run/inputs',
    report,
    counts,
  })
  const outputs = compareGroup({
    baseline: left.outputs,
    candidate: right.outputs,
    keyOf: (entry) => entry.id,
    ruleId: 'outputs-differ',
    kind: 'output',
    pointerBase: '/run/outputs',
    report,
    counts,
  })

  const comparedFiles = left.transformation.code.length + right.transformation.code.length
    + left.inputs.length + right.inputs.length + left.outputs.length + right.outputs.length
  if (comparedFiles === 0) {
    report.add('no-evidence-recorded', {
      file: BASELINE_LABEL,
      pointer: '/run',
      message: 'neither manifest records an input, an output or a code file, so there is nothing to compare',
    })
    return report.finish(counts)
  }

  const upstreamEqual = identityEqual && seedEqual && parametersEqual && code.equal && inputs.equal
  const upstreamKnown = code.known && inputs.known
  const intact = baseline.intact && candidate.intact

  if (!intact || !upstreamKnown || !outputs.known) return report.finish(counts)

  if (upstreamEqual && outputs.equal) {
    report.add('runs-reproduced', {
      file: BASELINE_LABEL,
      pointer: '/run',
      message:
        `"${left.runId}" and "${right.runId}" declare the same transformation, seed, parameters and input digests, `
        + 'and every output digest matches',
    })
  } else if (upstreamEqual && !outputs.equal) {
    report.add('output-nondeterministic', {
      file: BASELINE_LABEL,
      pointer: '/run/outputs',
      message:
        `"${left.runId}" and "${right.runId}" agree on every input digest, the transformation, the seed and every `
        + 'parameter, and their outputs differ, so this transformation did not reproduce',
      suggestion: 'look for an unrecorded input, an unseeded random source or a timestamp written into the output',
    })
  }
  return report.finish(counts)
}
