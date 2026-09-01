import type { ModelItem } from '@einfach-agent/ai'

import type { AgentHistoryTarget } from './agentHistoryTarget'
import type { AgentRolloutMutationV1, AgentRolloutRecordV1, AgentRunStatus } from './rolloutMutation'

export const AGENT_ROLLOUT_SCHEMA_VERSION = 1 as const
export const AGENT_ROLLOUT_MAX_LINE_BYTES = 1024 * 1024

const MAX_STRING_LENGTH = 512 * 1024
const MAX_ARRAY_LENGTH = 10_000
const MAX_OBJECT_KEYS = 256
const MAX_DEPTH = 32
const encoder = new TextEncoder()

type JsonObject = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new Error(`Invalid agent rollout record at ${path}: ${message}`)
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected a plain object')
  if (Object.keys(value).length > MAX_OBJECT_KEYS) fail(path, `exceeds ${MAX_OBJECT_KEYS} keys`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!(key in value)) fail(`${path}.${key}`, 'is required')
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'is not allowed')
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail(path, 'expected a non-empty string')
  if (value.length > MAX_STRING_LENGTH) fail(path, `exceeds ${MAX_STRING_LENGTH} characters`)
  return value
}

function ordinal(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, 'expected a non-negative safe integer')
  return value as number
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(path, 'expected a non-negative finite timestamp')
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
  return value
}

function isoTimestamp(value: unknown, path: string): string {
  const text = string(value, path)
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) fail(path, 'expected an ISO-8601 UTC timestamp')
  return text
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path)
}

function target(value: unknown, path: string): AgentHistoryTarget {
  const candidate = object(value, path)
  if (candidate.kind === 'root') {
    exactKeys(candidate, path, ['kind', 'conversationId'])
    return { kind: 'root', conversationId: string(candidate.conversationId, `${path}.conversationId`) }
  }
  if (candidate.kind === 'child') {
    exactKeys(candidate, path, ['kind', 'conversationId', 'runId', 'agentPath'])
    return {
      kind: 'child',
      conversationId: string(candidate.conversationId, `${path}.conversationId`),
      runId: string(candidate.runId, `${path}.runId`),
      agentPath: string(candidate.agentPath, `${path}.agentPath`),
    }
  }
  return fail(`${path}.kind`, 'expected root or child')
}

function boundedJson(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_DEPTH) fail(path, `exceeds maximum depth ${MAX_DEPTH}`)
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') { string(value, path, true); return }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'expected a finite JSON number')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) fail(path, `exceeds ${MAX_ARRAY_LENGTH} entries`)
    value.forEach((entry, index) => boundedJson(entry, `${path}[${index}]`, depth + 1))
    return
  }
  const candidate = object(value, path)
  for (const [key, entry] of Object.entries(candidate)) boundedJson(entry, `${path}.${key}`, depth + 1)
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path, true)
}

function toolCall(value: unknown, path: string): void {
  const candidate = object(value, path)
  exactKeys(candidate, path, ['id', 'type', 'function'])
  string(candidate.id, `${path}.id`)
  if (candidate.type !== 'function') fail(`${path}.type`, 'expected function')
  const functionCall = object(candidate.function, `${path}.function`)
  exactKeys(functionCall, `${path}.function`, ['name', 'arguments'])
  string(functionCall.name, `${path}.function.name`)
  string(functionCall.arguments, `${path}.function.arguments`, true)
}

function userContent(value: unknown, path: string): void {
  if (typeof value === 'string') { string(value, path, true); return }
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) fail(path, 'expected text or a bounded content array')
  value.forEach((entry, index) => {
    const blockPath = `${path}[${index}]`
    const block = object(entry, blockPath)
    if (block.type === 'text') {
      exactKeys(block, blockPath, ['type', 'text'])
      string(block.text, `${blockPath}.text`, true)
      return
    }
    if (block.type !== 'image') fail(`${blockPath}.type`, 'expected text or image')
    exactKeys(block, blockPath, ['type', 'source', 'name', 'mimeType', 'byteSize'], ['width', 'height'])
    const source = object(block.source, `${blockPath}.source`)
    exactKeys(source, `${blockPath}.source`, ['kind', 'provider', 'scope', 'reference'])
    if (source.kind !== 'provider-file') fail(`${blockPath}.source.kind`, 'expected provider-file')
    for (const key of ['provider', 'scope', 'reference'] as const) string(source[key], `${blockPath}.source.${key}`)
    string(block.name, `${blockPath}.name`)
    string(block.mimeType, `${blockPath}.mimeType`)
    ordinal(block.byteSize, `${blockPath}.byteSize`)
    if (block.width !== undefined) ordinal(block.width, `${blockPath}.width`)
    if (block.height !== undefined) ordinal(block.height, `${blockPath}.height`)
  })
}

function modelItem(value: unknown, path: string): ModelItem {
  boundedJson(value, path)
  const candidate = object(value, path)
  switch (candidate.role) {
    case 'system':
      exactKeys(candidate, path, ['role', 'content'])
      string(candidate.content, `${path}.content`, true)
      break
    case 'user':
      exactKeys(candidate, path, ['role', 'content'])
      userContent(candidate.content, `${path}.content`)
      break
    case 'assistant':
      exactKeys(candidate, path, ['role', 'content'], ['reasoning_content', 'tool_calls'])
      if (candidate.content !== null) string(candidate.content, `${path}.content`, true)
      if (candidate.reasoning_content !== null) optionalString(candidate.reasoning_content, `${path}.reasoning_content`)
      if (candidate.tool_calls !== undefined) {
        if (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length > MAX_ARRAY_LENGTH) fail(`${path}.tool_calls`, 'expected a bounded array')
        candidate.tool_calls.forEach((entry, index) => toolCall(entry, `${path}.tool_calls[${index}]`))
      }
      break
    case 'tool':
      exactKeys(candidate, path, ['role', 'tool_call_id', 'content'])
      string(candidate.tool_call_id, `${path}.tool_call_id`)
      string(candidate.content, `${path}.content`, true)
      break
    default: fail(`${path}.role`, 'unknown model role')
  }
  return value as ModelItem
}

const runStatuses: readonly AgentRunStatus[] = [
  'idle', 'running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation',
  'waiting_plan_approval', 'interrupted', 'done', 'stopped', 'error',
]

function mutation(value: JsonObject): AgentRolloutMutationV1 {
  const base = ['mutationType', 'target'] as const
  const decodedTarget = target(value.target, '$.target')
  switch (value.mutationType) {
    case 'session_meta':
      exactKeys(value, '$', [...base, 'title', 'createdAt', 'updatedAt'])
      return { mutationType: 'session_meta', target: decodedTarget, title: string(value.title, '$.title', true), createdAt: timestamp(value.createdAt, '$.createdAt'), updatedAt: timestamp(value.updatedAt, '$.updatedAt') }
    case 'turn_context': {
      exactKeys(value, '$', [...base, 'turnId', 'itemIds'])
      if (!Array.isArray(value.itemIds) || value.itemIds.length > MAX_ARRAY_LENGTH) fail('$.itemIds', 'expected a bounded array')
      return { mutationType: 'turn_context', target: decodedTarget, turnId: nullableString(value.turnId, '$.turnId'), itemIds: value.itemIds.map((entry, index) => string(entry, `$.itemIds[${index}]`)) }
    }
    case 'item_upsert':
      exactKeys(value, '$', [
        ...base,
        'itemId',
        'itemOrdinal',
        'createdAt',
        'item',
        'pending',
        'planStageId',
      ])
      return {
        mutationType: 'item_upsert',
        target: decodedTarget,
        itemId: string(value.itemId, '$.itemId'),
        itemOrdinal: ordinal(value.itemOrdinal, '$.itemOrdinal'),
        createdAt: timestamp(value.createdAt, '$.createdAt'),
        item: modelItem(value.item, '$.item'),
        pending: boolean(value.pending, '$.pending'),
        planStageId: nullableString(value.planStageId, '$.planStageId'),
      }
    case 'item_deleted':
      exactKeys(value, '$', [...base, 'itemId', 'reason'])
      return { mutationType: 'item_deleted', target: decodedTarget, itemId: string(value.itemId, '$.itemId'), reason: string(value.reason, '$.reason') }
    case 'run_state': {
      exactKeys(value, '$', [...base, 'runId', 'turnId', 'status', 'error'])
      if (!runStatuses.includes(value.status as AgentRunStatus)) fail('$.status', 'unknown run status')
      return { mutationType: 'run_state', target: decodedTarget, runId: nullableString(value.runId, '$.runId'), turnId: nullableString(value.turnId, '$.turnId'), status: value.status as AgentRunStatus, error: nullableString(value.error, '$.error') }
    }
    default: return fail('$.mutationType', 'unknown mutation type')
  }
}

export function decodeAgentRolloutRecord(line: string): AgentRolloutRecordV1 {
  if (encoder.encode(line).byteLength > AGENT_ROLLOUT_MAX_LINE_BYTES) fail('$', `line exceeds ${AGENT_ROLLOUT_MAX_LINE_BYTES} bytes`)
  if (line.includes('\n') || line.includes('\r')) fail('$', 'expected exactly one physical line')
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return fail('$', 'invalid JSON') }
  const candidate = object(parsed, '$')
  const persisted = ['schemaVersion', 'historyId', 'rolloutOrdinal', 'recordedAt'] as const
  if (candidate.schemaVersion !== AGENT_ROLLOUT_SCHEMA_VERSION) fail('$.schemaVersion', 'unsupported schema version')
  const decoded = mutation(Object.fromEntries(Object.entries(candidate).filter(([key]) => !persisted.includes(key as typeof persisted[number]))))
  return {
    ...decoded,
    schemaVersion: AGENT_ROLLOUT_SCHEMA_VERSION,
    historyId: string(candidate.historyId, '$.historyId'),
    rolloutOrdinal: ordinal(candidate.rolloutOrdinal, '$.rolloutOrdinal'),
    recordedAt: isoTimestamp(candidate.recordedAt, '$.recordedAt'),
  }
}

export function encodeAgentRolloutRecord(record: AgentRolloutRecordV1): string {
  const encoded = JSON.stringify(record)
  decodeAgentRolloutRecord(encoded)
  return encoded
}
