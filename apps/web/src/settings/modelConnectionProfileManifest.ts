import type { ConnectionProfileModel } from './modelConnectionProfileHost'

const MAX_MANIFEST_TEXT_LENGTH = 64 * 1024
const MAX_MODELS = 100
const MAX_LABEL_LENGTH = 128
const MAX_MODEL_ID_LENGTH = 256
const MAX_BASE_URL_LENGTH = 512
const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export interface ImportedModelConnectionProfile {
  readonly label: string
  readonly baseUrl: string
  readonly models: readonly ConnectionProfileModel[]
}

function manifestError(message: string): never {
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireExactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    manifestError('连接清单包含不支持的字段。')
  }
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') manifestError('连接清单格式不正确。')
  const trimmed = value.trim()
  if (!trimmed) manifestError('连接清单格式不正确。')
  return trimmed
}

function requireLimitedText(value: unknown, maximumLength: number): string {
  const text = requireText(value)
  if (text.length > maximumLength) manifestError('连接清单字段长度超出限制。')
  return text
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || IPV4_LOOPBACK_PATTERN.test(hostname)
}

function normalizeBaseUrl(value: unknown): string {
  const text = requireLimitedText(value, MAX_BASE_URL_LENGTH)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return manifestError('连接清单接入点地址无效。')
  }
  if (url.username || url.password || url.search || url.hash) {
    return manifestError('连接清单接入点地址无效。')
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHostname(url.hostname)) return manifestError('连接清单接入点地址无效。')
  } else if (url.protocol !== 'https:') {
    return manifestError('连接清单接入点地址无效。')
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

function parseModels(value: unknown): readonly ConnectionProfileModel[] {
  if (!Array.isArray(value) || value.length === 0) manifestError('连接清单格式不正确。')
  if (value.length > MAX_MODELS) manifestError('连接清单包含过多模型。')
  const ids = new Set<string>()
  return value.map((candidate) => {
    if (!isRecord(candidate)) manifestError('连接清单格式不正确。')
    requireExactFields(candidate, ['id', 'label'])
    const id = requireLimitedText(candidate.id, MAX_MODEL_ID_LENGTH)
    if (ids.has(id)) manifestError('连接清单模型 ID 不可重复。')
    ids.add(id)
    const label = candidate.label === undefined
      ? id
      : requireLimitedText(candidate.label, MAX_LABEL_LENGTH)
    return { id, label, source: 'manual' }
  })
}

/** Parses one non-secret OpenAI-compatible connection manifest without changing application state. */
export function parseModelConnectionProfileManifest(text: string): ImportedModelConnectionProfile {
  if (typeof text !== 'string' || text.length > MAX_MANIFEST_TEXT_LENGTH) {
    manifestError('连接清单文本过大。')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return manifestError('连接清单不是有效的 JSON。')
  }
  if (!isRecord(manifest)) manifestError('连接清单格式不正确。')
  requireExactFields(manifest, ['version', 'connection'])
  if (manifest.version !== 1 || !isRecord(manifest.connection)) {
    manifestError('连接清单格式不正确。')
  }
  const connection = manifest.connection
  requireExactFields(connection, ['label', 'kind', 'baseUrl', 'models'])
  if (connection.kind !== 'openai-compatible') manifestError('连接清单格式不正确。')
  return {
    label: requireLimitedText(connection.label, MAX_LABEL_LENGTH),
    baseUrl: normalizeBaseUrl(connection.baseUrl),
    models: parseModels(connection.models),
  }
}
