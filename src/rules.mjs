/**
 * One frozen ruleId -> severity table.
 *
 * Severity is not a label, it is the exit code: flipping one rule from `error`
 * to `info` turns a refusal into a green build. As a literal at many
 * construction sites it drifts silently, so every finding takes its severity
 * from here and an unknown rule throws.
 *
 * Asserting this table against a hand-written expected map in the tests is NOT
 * the guard -- three declarations can be edited together, and 40 of 52 rules
 * survived exactly that flip in another tool. `test/severity-exit.test.mjs`
 * drives real inputs through the real entry point and pins the observable
 * outcome: status and CLI exit code.
 */
export const RULE_SEVERITY = Object.freeze({
  'code-digest-mismatch': 'error',
  'digest-unresolved': 'warning',
  'evidence-unresolved': 'warning',
  'file-too-large': 'warning',
  'file-unreadable': 'warning',
  'finding-limit-reached': 'warning',
  'input-digest-mismatch': 'error',
  'inputs-differ': 'error',
  'manifest-integrity-mismatch': 'error',
  'manifest-invalid': 'error',
  'manifest-recorded': 'info',
  'manifest-too-large': 'error',
  'manifest-unreadable': 'error',
  'no-evidence-recorded': 'error',
  'output-digest-mismatch': 'error',
  'output-nondeterministic': 'error',
  'outputs-differ': 'error',
  'parameters-differ': 'error',
  'path-outside-root': 'error',
  'run-description-invalid': 'error',
  'run-description-unreadable': 'error',
  'runs-reproduced': 'info',
  'secret-refs-differ': 'info',
  'seed-differs': 'error',
  'transformation-differs': 'error',
  'verification-complete': 'info',
})

/**
 * The rules that mean evidence was missing, unsupported or unobtainable.
 *
 * Every one of these sets `incomplete`, and for the four warning-severity rules
 * in the list that flag is the ONLY thing standing between the run and a green
 * exit 0. Deleting one `incomplete = true` elsewhere in this catalog turned
 * exit 2 into exit 1 with the whole suite green, so each of these has a test
 * that pins the exit code rather than the finding.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'digest-unresolved',
  'evidence-unresolved',
  'file-too-large',
  'file-unreadable',
  'finding-limit-reached',
  'manifest-invalid',
  'manifest-too-large',
  'manifest-unreadable',
  'no-evidence-recorded',
  'path-outside-root',
  'run-description-invalid',
  'run-description-unreadable',
])

export function severityOf(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`unknown ruleId: ${ruleId}`)
  return severity
}

export function marksIncomplete(ruleId) {
  return INCOMPLETE_RULES.includes(ruleId)
}
