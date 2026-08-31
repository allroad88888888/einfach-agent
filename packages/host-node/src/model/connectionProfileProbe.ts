import { normalizeApiKey } from './credentials'
import { ModelRequestError, modelRequestError } from './errors'
import { requireOpenAiCompatBaseUrl } from './openAiCompatBaseUrl'
import { isJsonRecord } from './wireShape'
import type { ConnectionProfileModel } from './connectionProfile'

const PROBE_TIMEOUT_MS = 10_000
const MAX_PROBE_RESPONSE_BYTES = 256 * 1024
const MAX_DISCOVERED_MODELS = 1_000
const MAX_MODEL_ID_BYTES = 200
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

export interface ModelConnectionProfileProbeInput {
  readonly baseUrl: string
  readonly apiKey?: string
}

export interface ModelConnectionProfileProbeResult {
  readonly models: readonly ConnectionProfileModel[]
}

export interface ConnectionProfileProbeDeps {
  readonly fetchImpl?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

function invalidResponse(): never {
  throw modelRequestError('upstreamFailed')
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string') invalidResponse()
  const id = value.trim()
  if (
    id.length === 0
    || Buffer.byteLength(id, 'utf8') > MAX_MODEL_ID_BYTES
    || CONTROL_CHARACTER_PATTERN.test(id)
  ) invalidResponse()
  return id
}

function normalizeModels(value: unknown): readonly ConnectionProfileModel[] {
  if (!isJsonRecord(value) || !Array.isArray(value.data)) invalidResponse()
  if (value.data.length > MAX_DISCOVERED_MODELS) invalidResponse()
  const ids = new Set<string>()
  for (const entry of value.data) {
    if (!isJsonRecord(entry)) invalidResponse()
    ids.add(normalizeModelId(entry.id))
  }
  return [...ids]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id, label: id, source: 'discovered' as const }))
}

async function readLimitedJson(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) invalidResponse()
  if (!response.body) invalidResponse()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) invalidResponse()
      chunks.push(chunk.value)
    }
  } catch {
    invalidResponse()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    invalidResponse()
  }
}

export async function probeConnectionProfileModels(
  input: ModelConnectionProfileProbeInput,
  deps: ConnectionProfileProbeDeps = {},
): Promise<ModelConnectionProfileProbeResult> {
  const baseUrl = requireOpenAiCompatBaseUrl(input.baseUrl)
  const apiKey = input.apiKey === undefined ? undefined : normalizeApiKey(input.apiKey)
  if (input.apiKey !== undefined && apiKey === undefined) {
    throw modelRequestError('invalidApiKey')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const headers = new Headers({ accept: 'application/json' })
    if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`)
    const response = await (deps.fetchImpl ?? globalThis.fetch)(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) invalidResponse()
    const payload = await readLimitedJson(
      response,
      deps.maxResponseBytes ?? MAX_PROBE_RESPONSE_BYTES,
    )
    return { models: normalizeModels(payload) }
  } catch (error) {
    if (error instanceof ModelRequestError) throw error
    throw modelRequestError('upstreamFailed')
  } finally {
    clearTimeout(timer)
  }
}
