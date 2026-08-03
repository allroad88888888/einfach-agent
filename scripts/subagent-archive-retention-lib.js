export const SUBAGENT_RETENTION_MANIFEST_VERSION = 1

const DERIVED_PATHS = ['tree.json', 'nodes/', 'results/', 'traces/', 'skills/']
const SHA256 = /^[a-f0-9]{64}$/
const SEGMENT = /^(?!\.\.?$)[a-zA-Z0-9._-]{1,96}$/

function nonEmptyString(value, context) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context} must be a non-empty string`)
  return value
}

function nonNegativeInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${context} must be a non-negative integer`)
  return value
}

function compareRuns(left, right) {
  return left.sortAt - right.sortAt || left.conversationId.localeCompare(right.conversationId) || left.runId.localeCompare(right.runId)
}

/** Returns whether a path is a regenerable run artifact, never audit metadata. */
export function isDerivedArchivePath(relativePath) {
  return DERIVED_PATHS.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix))
}

/** Chooses the oldest regenerable run artifacts needed to reach an active-archive threshold. */
export function planArchiveRetention({ archiveBytes, maxBytes, runs }) {
  nonNegativeInteger(archiveBytes, 'archiveBytes')
  nonNegativeInteger(maxBytes, 'maxBytes')
  if (!Array.isArray(runs)) throw new Error('runs must be an array')

  let projectedArchiveBytes = archiveBytes
  const selectedRuns = []
  for (const run of [...runs].sort(compareRuns)) {
    nonEmptyString(run.conversationId, 'run conversationId')
    nonEmptyString(run.runId, 'run runId')
    nonNegativeInteger(run.reclaimableBytes, 'run reclaimableBytes')
    if (projectedArchiveBytes <= maxBytes || run.reclaimableBytes === 0) continue
    selectedRuns.push(run)
    projectedArchiveBytes -= run.reclaimableBytes
  }

  return {
    archiveBytes,
    maxBytes,
    selectedRuns,
    reclaimableBytes: selectedRuns.reduce((total, run) => total + run.reclaimableBytes, 0),
    projectedArchiveBytes,
    thresholdReached: projectedArchiveBytes <= maxBytes,
  }
}

function validateManifestFile(file, context, derivedOnly) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`${context} must be an object`)
  const path = nonEmptyString(file.path, `${context} path`)
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${context} path is unsafe`)
  }
  if (derivedOnly && !isDerivedArchivePath(path)) throw new Error(`${context} is not a derived artifact`)
  nonNegativeInteger(file.bytes, `${context} bytes`)
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw new Error(`${context} sha256 is invalid`)
  return { path, bytes: file.bytes, sha256: file.sha256 }
}

function validateManifestRun(run, index, derivedOnly) {
  const context = `manifest run ${index + 1}`
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error(`${context} must be an object`)
  const conversationId = nonEmptyString(run.conversationId, `${context} conversationId`)
  const runId = nonEmptyString(run.runId, `${context} runId`)
  if (!SEGMENT.test(conversationId) || !SEGMENT.test(runId)) throw new Error(`${context} has an unsafe identity`)
  if (!Array.isArray(run.files) || run.files.length === 0) throw new Error(`${context} files must be a non-empty array`)
  const files = run.files.map((file, fileIndex) => validateManifestFile(file, `${context} file ${fileIndex + 1}`, derivedOnly))
  const paths = new Set(files.map((file) => file.path))
  if (paths.size !== files.length) throw new Error(`${context} has duplicate file paths`)
  return { conversationId, runId, files }
}

/** Creates the portable, checksum-protected manifest used by export and recovery. */
export function createArchiveRetentionManifest(input) {
  const kind = input?.kind
  if (kind !== 'subagent_archive_export' && kind !== 'subagent_retention_prune') throw new Error('manifest kind is invalid')
  const selectedRuns = input?.selectedRuns
  if (!Array.isArray(selectedRuns) || selectedRuns.length === 0) throw new Error('manifest selectedRuns must be a non-empty array')
  const derivedOnly = kind === 'subagent_retention_prune'
  const runs = selectedRuns.map((run, index) => validateManifestRun(run, index, derivedOnly))
  return {
    version: SUBAGENT_RETENTION_MANIFEST_VERSION,
    kind,
    createdAt: nonEmptyString(input.createdAt, 'manifest createdAt'),
    archiveBytesBefore: nonNegativeInteger(input.archiveBytesBefore, 'manifest archiveBytesBefore'),
    projectedArchiveBytesAfter: nonNegativeInteger(input.projectedArchiveBytesAfter, 'manifest projectedArchiveBytesAfter'),
    selectedRuns: runs,
  }
}

/** Validates an untrusted export manifest before it can drive archive recovery. */
export function validateArchiveRetentionManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.version !== SUBAGENT_RETENTION_MANIFEST_VERSION) {
    throw new Error('invalid archive retention manifest version')
  }
  return createArchiveRetentionManifest(manifest)
}
