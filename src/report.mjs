/**
 * The report envelope, its ordering, and the one place `status` is decided.
 *
 * Every path that could set `status` runs through `finish()`. A tool in this
 * catalog reported `pass` on an input it had never read because one branch set
 * the status itself, so nothing here sets it anywhere else.
 */

import { LIMITS } from './limits.mjs'
import { marksIncomplete, severityOf } from './rules.mjs'
import { byCodeUnit, excerpt, sanitise } from './text.mjs'

export const TOOL_ID = 'etl-run-manifest'
export const SCHEMA_VERSION = '1'

/**
 * Collects findings and the one `incomplete` flag.
 *
 * `incomplete` is never set by a caller. It is derived from the rule id, so a
 * new rule cannot forget it and an existing rule cannot quietly lose it.
 */
export class ReportBuilder {
  constructor(limits = LIMITS) {
    this.limits = limits
    this.findings = []
    this.incomplete = false
    this.dropped = 0
  }

  add(ruleId, { file, pointer = null, message, evidence = null, suggestion = null }) {
    const severity = severityOf(ruleId)
    if (marksIncomplete(ruleId)) this.incomplete = true
    if (this.findings.length >= this.limits.maxFindings) {
      this.dropped += 1
      return
    }
    const finding = {
      ruleId,
      severity,
      message: sanitise(message),
      location: { file: sanitise(file) },
    }
    if (pointer !== null) finding.location.pointer = sanitise(pointer)
    if (evidence !== null) finding.evidence = excerpt(evidence)
    if (suggestion !== null) finding.suggestion = sanitise(suggestion)
    this.findings.push(finding)
  }

  /** Build the envelope. The only place `status` is chosen. */
  finish(counts = {}) {
    if (this.dropped > 0) {
      const ruleId = 'finding-limit-reached'
      this.incomplete = true
      this.findings.push({
        ruleId,
        severity: severityOf(ruleId),
        message:
          `the report stopped at ${this.limits.maxFindings} findings and ${this.dropped} more were not `
          + 'recorded, so this report does not describe everything that was observed',
        location: { file: '(report)' },
      })
    }
    const ordered = [...this.findings].sort(
      (left, right) =>
        byCodeUnit(left.location.file, right.location.file)
        || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
        || byCodeUnit(left.ruleId, right.ruleId)
        || byCodeUnit(left.message, right.message),
    )
    const errors = ordered.filter((finding) => finding.severity === 'error').length
    const warnings = ordered.filter((finding) => finding.severity === 'warning').length
    const status = this.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
    return {
      schemaVersion: SCHEMA_VERSION,
      tool: TOOL_ID,
      status,
      summary: { checked: 0, ...counts, errors, warnings },
      findings: ordered,
    }
  }
}

/**
 * Exit code from status.
 *
 * `incomplete` outranks `fail`: a run that could not obtain its evidence has
 * not established that the policy failed either, and the contract reserves 2
 * for exactly that.
 */
export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  if (report.status === 'fail') return 1
  return 0
}

/** The JSON that goes to stdout, and nothing else. */
export function serializeReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

const SEVERITY_WIDTH = 7

/** The human summary, which goes to stderr. */
export function formatReport(report, headline) {
  const lines = [`${TOOL_ID}: ${headline}`, `status ${report.status}`]
  const summary = report.summary
  lines.push(
    Object.keys(summary)
      .sort(byCodeUnit)
      .map((key) => `${key} ${summary[key]}`)
      .join(', '),
  )
  for (const finding of report.findings) {
    const pointer = finding.location.pointer === undefined ? '' : ` ${finding.location.pointer}`
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} `
      + `${finding.location.file}${pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}
