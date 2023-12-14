/**
 * The documented shape of a run description and of a manifest.
 *
 * Two rules here do the credential work, and both are structural rather than a
 * filter applied afterwards:
 *
 * 1. EVERY key set is an ALLOW-LIST. No object from an input document is ever
 *    spread, merged or copied wholesale into a manifest -- each field is read
 *    by name -- and a key the schema does not name is refused rather than
 *    carried along. A `"password"` sitting beside `"batch_size"` never travels,
 *    because the document holding it is refused outright.
 * 2. A credential is declared BY REFERENCE and there is no field for its value.
 *    `secretRefs` entries carry a name and a source kind, nothing else, so the
 *    tool has no value to record, and it never reads an environment variable, a
 *    profile or a keychain to obtain one. Excluding a secret is not something
 *    this tool does to a value it holds; it never holds one.
 *
 * Strings are REFUSED rather than sanitised. Sanitising an identifier or a path
 * would change what it refers to -- two ids differing only by a bidi mark would
 * collide, and a path with a stripped character would name a different file --
 * so a field whose rendered form differs from the form it was given is rejected
 * with its pointer. Nothing is silently altered, which closes the gap between
 * "is this present and usable" and "what will be rendered" by construction.
 */

import { LIMITS } from './limits.mjs'
import { excerpt, isPlainObject, sanitise, typeName } from './text.mjs'

export const RUN_SCHEMA = 'edilec.etl-run/v1'
export const MANIFEST_SCHEMA = 'edilec.etl-manifest/v1'
export const DIGEST_ALGORITHM = 'sha256'

/** The kinds of place a credential can live. The tool reads none of them. */
export const SECRET_SOURCES = Object.freeze(['env', 'file', 'keychain', 'parameter-store', 'vault', 'other'])

const RUN_KEYS = Object.freeze([
  'inputs', 'outputs', 'parameters', 'parentRunIds', 'recordedAt', 'runId', 'schema', 'secretRefs', 'seed',
  'transformation',
])
const RUN_REQUIRED = Object.freeze(['inputs', 'outputs', 'runId', 'schema', 'transformation'])
const TRANSFORM_KEYS = Object.freeze(['code', 'id', 'version'])
const TRANSFORM_REQUIRED = Object.freeze(['id', 'version'])
const DATASET_KEYS = Object.freeze(['id', 'path'])
const CODE_KEYS = Object.freeze(['path'])
const PARAMETER_KEYS = Object.freeze(['name', 'value'])
const SECRET_KEYS = Object.freeze(['name', 'source'])

const MANIFEST_KEYS = Object.freeze(['integrity', 'run', 'schema', 'tool'])
const RECORDED_RUN_KEYS = Object.freeze([
  'inputs', 'outputs', 'parameters', 'parentRunIds', 'recordedAt', 'runId', 'secretRefs', 'seed', 'transformation',
])
const RECORDED_TRANSFORM_KEYS = Object.freeze(['code', 'id', 'version'])
const RECORDED_FILE_KEYS = Object.freeze(['bytes', 'digest', 'id', 'path', 'unresolved'])
const RECORDED_CODE_KEYS = Object.freeze(['bytes', 'digest', 'path', 'unresolved'])
const INTEGRITY_KEYS = Object.freeze(['algorithm', 'digest'])

const HEX_DIGEST = /^[0-9a-f]{64}$/

class Problems {
  constructor() {
    this.list = []
  }

  add(pointer, message) {
    this.list.push({ pointer, message })
  }

  get ok() {
    return this.list.length === 0
  }
}

function checkKeys(value, allowed, required, pointer, problems) {
  if (!isPlainObject(value)) {
    problems.add(pointer, `must be an object, not ${typeName(value)}`)
    return false
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) {
      problems.add(`${pointer}/${key}`, `is not a key this schema defines; allowed keys are ${allowed.join(', ')}`)
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) problems.add(`${pointer}/${key}`, 'is required and is missing')
  }
  return true
}

/** A string that is present, bounded, and identical to what will be rendered. */
function cleanString(raw, pointer, problems, limit) {
  if (typeof raw !== 'string') {
    problems.add(pointer, `must be a string, not ${typeName(raw)}`)
    return null
  }
  if (raw.length === 0) {
    problems.add(pointer, 'must not be empty')
    return null
  }
  if (raw.length > limit) {
    problems.add(pointer, `is ${raw.length} characters, over the limit of ${limit}`)
    return null
  }
  if (sanitise(raw) !== raw) {
    problems.add(pointer, 'contains a control, bidi or line-separator character, which would render as something else')
    return null
  }
  return raw
}

function relativePath(raw, pointer, problems, limits) {
  const value = cleanString(raw, pointer, problems, limits.maxPathChars)
  if (value === null) return null
  if (value.startsWith('/')) {
    problems.add(pointer, 'must be relative to the declared root, and this path is absolute')
    return null
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    problems.add(pointer, 'must not contain an empty, "." or ".." segment')
    return null
  }
  return value
}

function uniqueList(values, pointer, problems, label) {
  const seen = new Set()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === null) continue
    if (seen.has(value)) problems.add(`${pointer}/${index}`, `repeats the ${label} "${excerpt(value, 80)}"`)
    seen.add(value)
  }
}

function boundedArray(value, pointer, problems, limit, label) {
  if (!Array.isArray(value)) {
    problems.add(pointer, `must be an array, not ${typeName(value)}`)
    return null
  }
  if (value.length > limit) {
    problems.add(pointer, `holds ${value.length} ${label}, over the limit of ${limit}`)
    return null
  }
  return value
}

function parameterValue(raw, pointer, problems, limits) {
  if (raw === null) return { value: null }
  const kind = typeof raw
  if (kind === 'boolean') return { value: raw }
  if (kind === 'number') {
    if (!Number.isFinite(raw)) {
      problems.add(pointer, 'must be a finite number')
      return null
    }
    return { value: raw }
  }
  if (kind === 'string') {
    const value = cleanString(raw, pointer, problems, limits.maxValueChars)
    return value === null ? null : { value }
  }
  problems.add(
    pointer,
    `must be a string, number, boolean or null, not ${typeName(raw)}`
    + ' (a credential belongs in secretRefs, which records a name and never a value)',
  )
  return null
}

function seedValue(raw, pointer, problems, limits) {
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      problems.add(pointer, 'must be a safe integer when it is a number')
      return null
    }
    return { value: raw }
  }
  if (typeof raw === 'string') {
    const value = cleanString(raw, pointer, problems, limits.maxValueChars)
    return value === null ? null : { value }
  }
  problems.add(pointer, `must be an integer, a string or null, not ${typeName(raw)}`)
  return null
}

function datasetList(raw, pointer, problems, limits, limit, label) {
  const list = boundedArray(raw ?? [], pointer, problems, limit, label)
  if (list === null) return null
  const entries = []
  for (let index = 0; index < list.length; index += 1) {
    const at = `${pointer}/${index}`
    if (!checkKeys(list[index], DATASET_KEYS, DATASET_KEYS, at, problems)) continue
    const id = cleanString(list[index].id, `${at}/id`, problems, limits.maxIdentifierChars)
    const path = relativePath(list[index].path, `${at}/path`, problems, limits)
    entries.push({ id, path })
  }
  uniqueList(entries.map((entry) => entry.id), pointer, problems, 'dataset id')
  return entries
}

/**
 * Validate a parsed run description.
 *
 * Returns `{ ok: true, run }` with every field read by name, or
 * `{ ok: false, problems }` listing each pointer. A document with one bad field
 * still reports the others: a caller fixing a run description one error per run
 * is a caller who stops using the tool.
 */
export function compileRunDescription(document, limits = LIMITS) {
  const problems = new Problems()
  if (!checkKeys(document, RUN_KEYS, RUN_REQUIRED, '', problems)) {
    return { ok: false, problems: problems.list }
  }
  if (document.schema !== RUN_SCHEMA) {
    problems.add(
      '/schema',
      `must be "${RUN_SCHEMA}"; this document declares "${excerpt(
        typeof document.schema === 'string' ? document.schema : typeName(document.schema), 80,
      )}"`,
    )
  }
  const runId = cleanString(document.runId, '/runId', problems, limits.maxIdentifierChars)
  const recordedAt = document.recordedAt === undefined || document.recordedAt === null
    ? null
    : cleanString(document.recordedAt, '/recordedAt', problems, limits.maxValueChars)

  const parentsRaw = boundedArray(document.parentRunIds ?? [], '/parentRunIds', problems, limits.maxParentRuns, 'parent run ids')
  const parentRunIds = parentsRaw === null
    ? []
    : parentsRaw.map((value, index) => cleanString(value, `/parentRunIds/${index}`, problems, limits.maxIdentifierChars))
  uniqueList(parentRunIds, '/parentRunIds', problems, 'parent run id')

  let transformation = null
  if (checkKeys(document.transformation, TRANSFORM_KEYS, TRANSFORM_REQUIRED, '/transformation', problems)) {
    const codeRaw = boundedArray(
      document.transformation.code ?? [], '/transformation/code', problems, limits.maxCodeFiles, 'code files',
    )
    const code = codeRaw === null
      ? []
      : codeRaw.map((entry, index) => {
        const at = `/transformation/code/${index}`
        if (!checkKeys(entry, CODE_KEYS, CODE_KEYS, at, problems)) return { path: null }
        return { path: relativePath(entry.path, `${at}/path`, problems, limits) }
      })
    uniqueList(code.map((entry) => entry.path), '/transformation/code', problems, 'code path')
    transformation = {
      id: cleanString(document.transformation.id, '/transformation/id', problems, limits.maxIdentifierChars),
      version: cleanString(document.transformation.version, '/transformation/version', problems, limits.maxValueChars),
      code,
    }
  }

  const seed = seedValue(document.seed, '/seed', problems, limits)

  const parametersRaw = boundedArray(document.parameters ?? [], '/parameters', problems, limits.maxParameters, 'parameters')
  const parameters = parametersRaw === null
    ? []
    : parametersRaw.map((entry, index) => {
      const at = `/parameters/${index}`
      if (!checkKeys(entry, PARAMETER_KEYS, PARAMETER_KEYS, at, problems)) return { name: null, value: null }
      const name = cleanString(entry.name, `${at}/name`, problems, limits.maxIdentifierChars)
      const held = parameterValue(entry.value, `${at}/value`, problems, limits)
      return { name, value: held === null ? null : held.value }
    })
  uniqueList(parameters.map((entry) => entry.name), '/parameters', problems, 'parameter name')

  const secretsRaw = boundedArray(document.secretRefs ?? [], '/secretRefs', problems, limits.maxSecretRefs, 'secret references')
  const secretRefs = secretsRaw === null
    ? []
    : secretsRaw.map((entry, index) => {
      const at = `/secretRefs/${index}`
      if (!checkKeys(entry, SECRET_KEYS, SECRET_KEYS, at, problems)) return { name: null, source: null }
      const name = cleanString(entry.name, `${at}/name`, problems, limits.maxIdentifierChars)
      let source = null
      if (typeof entry.source === 'string' && SECRET_SOURCES.includes(entry.source)) source = entry.source
      else {
        problems.add(
          `${at}/source`,
          `must be one of ${SECRET_SOURCES.join(', ')}; this schema has no field for a credential value`,
        )
      }
      return { name, source }
    })
  uniqueList(secretRefs.map((entry) => entry.name), '/secretRefs', problems, 'secret reference name')

  const inputs = datasetList(document.inputs, '/inputs', problems, limits, limits.maxInputs, 'inputs')
  const outputs = datasetList(document.outputs, '/outputs', problems, limits, limits.maxOutputs, 'outputs')

  if (!problems.ok) return { ok: false, problems: problems.list }
  return {
    ok: true,
    run: {
      runId,
      recordedAt,
      parentRunIds,
      transformation,
      seed: seed.value,
      parameters,
      secretRefs,
      inputs: inputs ?? [],
      outputs: outputs ?? [],
    },
  }
}

function recordedFile(entry, at, problems, limits, keys, withId) {
  if (!checkKeys(entry, keys, keys, at, problems)) return null
  const id = withId ? cleanString(entry.id, `${at}/id`, problems, limits.maxIdentifierChars) : undefined
  const path = relativePath(entry.path, `${at}/path`, problems, limits)
  let digest = null
  if (entry.digest !== null) {
    if (typeof entry.digest !== 'string' || !HEX_DIGEST.test(entry.digest)) {
      problems.add(`${at}/digest`, `must be null or 64 lowercase hex characters (${DIGEST_ALGORITHM})`)
    } else digest = entry.digest
  }
  let bytes = null
  if (entry.bytes !== null) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      problems.add(`${at}/bytes`, 'must be null or a non-negative integer')
    } else bytes = entry.bytes
  }
  let unresolved = null
  if (entry.unresolved !== null) unresolved = cleanString(entry.unresolved, `${at}/unresolved`, problems, limits.maxValueChars)
  if (digest === null && unresolved === null) {
    problems.add(at, 'has no digest and no reason for not having one; an unrecorded digest must say why')
  }
  if (digest !== null && unresolved !== null) {
    problems.add(at, 'carries both a digest and a reason for not having one')
  }
  return withId ? { id, path, digest, bytes, unresolved } : { path, digest, bytes, unresolved }
}

/** Validate a parsed manifest document produced by an earlier `record`. */
export function compileManifest(document, limits = LIMITS) {
  const problems = new Problems()
  if (!checkKeys(document, MANIFEST_KEYS, MANIFEST_KEYS, '', problems)) {
    return { ok: false, problems: problems.list }
  }
  if (document.schema !== MANIFEST_SCHEMA) {
    problems.add(
      '/schema',
      `must be "${MANIFEST_SCHEMA}"; this document declares "${excerpt(
        typeof document.schema === 'string' ? document.schema : typeName(document.schema), 80,
      )}"`,
    )
  }
  if (document.tool !== 'etl-run-manifest') problems.add('/tool', 'must be "etl-run-manifest"')

  let integrity = null
  if (checkKeys(document.integrity, INTEGRITY_KEYS, INTEGRITY_KEYS, '/integrity', problems)) {
    if (document.integrity.algorithm !== DIGEST_ALGORITHM) {
      problems.add('/integrity/algorithm', `must be "${DIGEST_ALGORITHM}"`)
    }
    if (typeof document.integrity.digest !== 'string' || !HEX_DIGEST.test(document.integrity.digest)) {
      problems.add('/integrity/digest', 'must be 64 lowercase hex characters')
    } else integrity = { algorithm: DIGEST_ALGORITHM, digest: document.integrity.digest }
  }

  let run = null
  if (checkKeys(document.run, RECORDED_RUN_KEYS, RECORDED_RUN_KEYS, '/run', problems)) {
    const runId = cleanString(document.run.runId, '/run/runId', problems, limits.maxIdentifierChars)
    const recordedAt = document.run.recordedAt === null
      ? null
      : cleanString(document.run.recordedAt, '/run/recordedAt', problems, limits.maxValueChars)
    const parentsRaw = boundedArray(
      document.run.parentRunIds, '/run/parentRunIds', problems, limits.maxParentRuns, 'parent run ids',
    )
    const parentRunIds = parentsRaw === null
      ? []
      : parentsRaw.map((value, index) => cleanString(value, `/run/parentRunIds/${index}`, problems, limits.maxIdentifierChars))

    let transformation = null
    if (checkKeys(document.run.transformation, RECORDED_TRANSFORM_KEYS, RECORDED_TRANSFORM_KEYS, '/run/transformation', problems)) {
      const codeRaw = boundedArray(
        document.run.transformation.code, '/run/transformation/code', problems, limits.maxCodeFiles, 'code files',
      )
      const code = codeRaw === null
        ? []
        : codeRaw
          .map((entry, index) => recordedFile(entry, `/run/transformation/code/${index}`, problems, limits, RECORDED_CODE_KEYS, false))
          .filter((entry) => entry !== null)
      transformation = {
        id: cleanString(document.run.transformation.id, '/run/transformation/id', problems, limits.maxIdentifierChars),
        version: cleanString(document.run.transformation.version, '/run/transformation/version', problems, limits.maxValueChars),
        code,
      }
    }

    const seed = seedValue(document.run.seed, '/run/seed', problems, limits)

    const parametersRaw = boundedArray(document.run.parameters, '/run/parameters', problems, limits.maxParameters, 'parameters')
    const parameters = parametersRaw === null
      ? []
      : parametersRaw.map((entry, index) => {
        const at = `/run/parameters/${index}`
        if (!checkKeys(entry, PARAMETER_KEYS, PARAMETER_KEYS, at, problems)) return { name: null, value: null }
        const held = parameterValue(entry.value, `${at}/value`, problems, limits)
        return {
          name: cleanString(entry.name, `${at}/name`, problems, limits.maxIdentifierChars),
          value: held === null ? null : held.value,
        }
      })

    const secretsRaw = boundedArray(document.run.secretRefs, '/run/secretRefs', problems, limits.maxSecretRefs, 'secret references')
    const secretRefs = secretsRaw === null
      ? []
      : secretsRaw.map((entry, index) => {
        const at = `/run/secretRefs/${index}`
        if (!checkKeys(entry, SECRET_KEYS, SECRET_KEYS, at, problems)) return { name: null, source: null }
        let source = null
        if (typeof entry.source === 'string' && SECRET_SOURCES.includes(entry.source)) source = entry.source
        else problems.add(`${at}/source`, `must be one of ${SECRET_SOURCES.join(', ')}`)
        return { name: cleanString(entry.name, `${at}/name`, problems, limits.maxIdentifierChars), source }
      })

    const files = (raw, pointer, limit, label) => {
      const list = boundedArray(raw, pointer, problems, limit, label)
      if (list === null) return []
      return list
        .map((entry, index) => recordedFile(entry, `${pointer}/${index}`, problems, limits, RECORDED_FILE_KEYS, true))
        .filter((entry) => entry !== null)
    }
    const inputs = files(document.run.inputs, '/run/inputs', limits.maxInputs, 'inputs')
    const outputs = files(document.run.outputs, '/run/outputs', limits.maxOutputs, 'outputs')
    uniqueList(inputs.map((entry) => entry.id), '/run/inputs', problems, 'dataset id')
    uniqueList(outputs.map((entry) => entry.id), '/run/outputs', problems, 'dataset id')

    run = { runId, recordedAt, parentRunIds, transformation, seed: seed === null ? null : seed.value, parameters, secretRefs, inputs, outputs }
  }

  if (!problems.ok) return { ok: false, problems: problems.list }
  return { ok: true, manifest: { run, integrity } }
}
