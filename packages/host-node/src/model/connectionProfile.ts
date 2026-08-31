// OpenAI-compatible connection profile 的公开/持久化形状与字段归一化。
// API Key 不属于这里的任何类型；它只通过 connectionProfileCredentialKey 指向凭据段。

import { modelRequestError } from './errors'
import { requireOpenAiCompatBaseUrl } from './openAiCompatBaseUrl'
import { hasExactKeys, isJsonRecord } from './wireShape'

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
const MAX_LABEL_BYTES = 120
const MAX_MODEL_BYTES = 200
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

const STORED_PROFILE_KEYS = ['id', 'label', 'kind', 'baseUrl', 'models'] as const
const LEGACY_STORED_PROFILE_KEYS = ['id', 'label', 'kind', 'baseUrl', 'model'] as const
const MODEL_KEYS = ['id', 'label', 'source'] as const

export interface ConnectionProfileModel {
  readonly id: string
  readonly label: string
  readonly source: 'manual' | 'discovered'
}

export interface StoredConnectionProfile {
  readonly id: string
  readonly label: string
  readonly kind: 'openai-compatible'
  readonly baseUrl: string
  readonly models: readonly ConnectionProfileModel[]
}

export interface ModelConnectionProfile extends StoredConnectionProfile {
  readonly credentialConfigured: boolean
}

export interface ConnectionProfileSaveFields {
  readonly id: unknown
  readonly label: unknown
  readonly baseUrl: unknown
  readonly models: unknown
}

function invalidRequest(): never {
  throw modelRequestError('invalidRequest')
}

function normalizeBoundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') invalidRequest()
  const normalized = value.trim()
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, 'utf8') > maxBytes
    || CONTROL_CHARACTER_PATTERN.test(normalized)
  ) invalidRequest()
  return normalized
}

/** IDs are stable lowercase ASCII identifiers and are never silently case-folded. */
export function normalizeConnectionProfileId(value: unknown): string {
  if (typeof value !== 'string') invalidRequest()
  const normalized = value.trim()
  if (!PROFILE_ID_PATTERN.test(normalized)) invalidRequest()
  return normalized
}

/** Normalize user-supplied public fields; the server always supplies the frozen kind. */
export function normalizeConnectionProfile(
  fields: ConnectionProfileSaveFields,
): StoredConnectionProfile {
  if (typeof fields.baseUrl !== 'string') invalidRequest()
  return {
    id: normalizeConnectionProfileId(fields.id),
    label: normalizeBoundedText(fields.label, MAX_LABEL_BYTES),
    kind: 'openai-compatible',
    baseUrl: requireOpenAiCompatBaseUrl(fields.baseUrl),
    models: normalizeConnectionProfileModels(fields.models),
  }
}

function normalizeConnectionProfileModel(value: unknown): ConnectionProfileModel {
  if (!isJsonRecord(value) || !hasExactKeys(value, MODEL_KEYS)) invalidRequest()
  if (value.source !== 'manual' && value.source !== 'discovered') invalidRequest()
  return {
    id: normalizeBoundedText(value.id, MAX_MODEL_BYTES),
    label: normalizeBoundedText(value.label, MAX_LABEL_BYTES),
    source: value.source,
  }
}

function normalizeConnectionProfileModels(value: unknown): readonly ConnectionProfileModel[] {
  if (!Array.isArray(value) || value.length === 0) invalidRequest()
  const models = value.map(normalizeConnectionProfileModel)
  if (new Set(models.map(({ id }) => id)).size !== models.length) invalidRequest()
  return models
}

/** Decode one untrusted persisted entry. Callers translate failures to config-format errors. */
export function normalizeStoredConnectionProfile(value: unknown): StoredConnectionProfile {
  if (!isJsonRecord(value)) invalidRequest()
  if (value.kind !== 'openai-compatible') invalidRequest()
  if (hasExactKeys(value, LEGACY_STORED_PROFILE_KEYS)) {
    const model = normalizeBoundedText(value.model, MAX_MODEL_BYTES)
    return normalizeConnectionProfile({
      ...value,
      models: [{ id: model, label: model, source: 'manual' }],
    } as unknown as ConnectionProfileSaveFields)
  }
  if (!hasExactKeys(value, STORED_PROFILE_KEYS)) invalidRequest()
  return normalizeConnectionProfile(value as unknown as ConnectionProfileSaveFields)
}

/** The only credential key namespace used by third-party profiles. */
export function connectionProfileCredentialKey(id: string): string {
  return `openai-compat:profile:${normalizeConnectionProfileId(id)}`
}
