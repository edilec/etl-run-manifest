/**
 * etl-run-manifest -- record what one ETL run consumed, ran and produced, and
 * be able to prove later that the record still holds.
 *
 * Three commands, one schema: `record` writes a manifest, `verify` re-hashes
 * what a manifest recorded, `compare` decides whether two manifests describe
 * the same run repeated.
 *
 * The tool opens no socket, resolves no host, reads no environment variable and
 * reads no clock. Every input is a document somebody exported and a file
 * somebody produced.
 */

export { LIMITS, OVERRIDABLE } from './limits.mjs'
export { MAX_DEPTH, canonicalDocument, canonicalJson } from './canonical.mjs'
export { DIGEST_ALGORITHM, digestText, hashFile, readJsonDocument, resolveRoot } from './files.mjs'
export { loadManifest } from './load.mjs'
export { BASELINE_LABEL, CANDIDATE_LABEL, compareManifests } from './compare.mjs'
export { MANIFEST_LABEL, RUN_LABEL, declaredPaths, recordRun } from './record.mjs'
export { verifyManifest } from './verify.mjs'
export { INCOMPLETE_RULES, RULE_SEVERITY, marksIncomplete, severityOf } from './rules.mjs'
export { ReportBuilder, SCHEMA_VERSION, TOOL_ID, exitCodeFor, formatReport, serializeReport } from './report.mjs'
export {
  DIGEST_ALGORITHM as SCHEMA_DIGEST_ALGORITHM,
  MANIFEST_SCHEMA,
  RUN_SCHEMA,
  SECRET_SOURCES,
  compileManifest,
  compileRunDescription,
} from './schema.mjs'
export { EXCERPT_LIMIT, byCodeUnit, decodeUtf8, excerpt, isPlainObject, renderable, sanitise, typeName } from './text.mjs'
export { UNPARSEABLE, parseFailureDetail } from './parse-failure.mjs'
export { DestinationError, assertWritableDestination } from './write-guard.mjs'
