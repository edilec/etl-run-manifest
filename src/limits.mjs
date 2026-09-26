/**
 * Declared bounds, enforced BEFORE the work rather than after it.
 *
 * A tool that dies of heap exhaustion at a size its own documentation calls
 * legal has already happened in this catalog: exit 134, empty stdout, outside
 * the documented exit contract. So every count is checked against the parsed
 * document before any file is opened, and every byte length is checked against
 * `stat` before any file is read.
 *
 * Every bound here is tested from BOTH sides: that it refuses at N+1 and that
 * it stays silent at exactly N. "Fires at N+1" and "silent at N" are two
 * assertions, and the second is the one users notice.
 */
export const LIMITS = Object.freeze({
  /** Bytes of any single JSON document (run description or manifest). */
  maxDocumentBytes: 1048576,
  /** Bytes of any single file this tool hashes. Checked with stat, before open. */
  maxFileBytes: 67108864,
  maxInputs: 512,
  maxOutputs: 256,
  maxCodeFiles: 128,
  maxParameters: 256,
  maxSecretRefs: 64,
  maxParentRuns: 64,
  /** Characters of an identifier: run id, dataset id, transformation id, parameter name. */
  maxIdentifierChars: 200,
  /** Characters of a declared relative path. */
  maxPathChars: 1024,
  /** Characters of a recorded parameter value, a version or a recordedAt label. */
  maxValueChars: 512,
  /** Findings emitted before the report says it stopped counting. */
  maxFindings: 500,
})

/** The names a caller may override on the command line, and their bound keys. */
export const OVERRIDABLE = Object.freeze({
  '--max-document-bytes': 'maxDocumentBytes',
  '--max-file-bytes': 'maxFileBytes',
  '--max-inputs': 'maxInputs',
  '--max-outputs': 'maxOutputs',
  '--max-code-files': 'maxCodeFiles',
  '--max-parameters': 'maxParameters',
  '--max-secret-refs': 'maxSecretRefs',
  '--max-parent-runs': 'maxParentRuns',
  '--max-findings': 'maxFindings',
})
