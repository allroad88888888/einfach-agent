import type { ModelItem } from '@einfach-agent/ai'

import {
  AGENT_HISTORY_ITEM_PREVIEW_MAX_CHARS,
  type AgentHistoryItemRole,
} from './historyQuery'

export const AGENT_HISTORY_ITEM_JSON_MAX_BYTES = 1024 * 1024

export interface BoundedUtf8ByteCount {
  readonly bytes: number
  readonly exceeded: boolean
  readonly codeUnitsRead: number
}

function codePointWidthAt(text: string, index: number): 1 | 2 {
  const high = text.charCodeAt(index)
  const low = text.charCodeAt(index + 1)
  return high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF ? 2 : 1
}

export function boundedUtf8ByteCount(text: string, maxBytes: number): BoundedUtf8ByteCount {
  let bytes = 0
  let index = 0
  while (index < text.length && bytes <= maxBytes) {
    const first = text.charCodeAt(index)
    const width = codePointWidthAt(text, index)
    bytes += width === 2 ? 4 : first <= 0x7F ? 1 : first <= 0x7FF ? 2 : 3
    index += width
  }
  return { bytes, exceeded: bytes > maxBytes, codeUnitsRead: index }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validUserBlock(value: unknown): boolean {
  const block = record(value)
  if (!block) return false
  if (block.type === 'text') return typeof block.text === 'string'
  if (block.type !== 'image' || typeof block.name !== 'string' || typeof block.mimeType !== 'string'
    || !Number.isSafeInteger(block.byteSize)) return false
  const source = record(block.source)
  return source?.kind === 'provider-file' && typeof source.provider === 'string'
    && typeof source.scope === 'string' && typeof source.reference === 'string'
}

function validToolCall(value: unknown): boolean {
  const call = record(value)
  const fn = record(call?.function)
  return typeof call?.id === 'string' && call.type === 'function'
    && typeof fn?.name === 'string' && typeof fn.arguments === 'string'
}

function codePointPrefix(text: string, limit: number): string {
  if (limit <= 0) return ''
  let end = 0
  let count = 0
  while (end < text.length && count < limit) {
    end += codePointWidthAt(text, end)
    count += 1
  }
  return text.slice(0, end)
}

function assertModelItem(value: unknown): asserts value is ModelItem {
  const item = record(value)
  if (!item) throw new Error('Invalid ModelItem JSON')
  if (!['system', 'user', 'assistant', 'tool'].includes(String(item.role))) throw new Error('Invalid ModelItem role')
  if (item.role === 'assistant') {
    if (item.content !== null && typeof item.content !== 'string') throw new Error('Invalid assistant content')
    if (item.reasoning_content !== undefined && item.reasoning_content !== null
      && typeof item.reasoning_content !== 'string') throw new Error('Invalid assistant reasoning_content')
    if (item.tool_calls !== undefined
      && (!Array.isArray(item.tool_calls) || !item.tool_calls.every(validToolCall))) {
      throw new Error('Invalid assistant tool_calls')
    }
    return
  }
  if (item.role === 'user' && Array.isArray(item.content)) {
    if (!item.content.every(validUserBlock)) throw new Error('Invalid user content')
    return
  }
  if (typeof item.content !== 'string') throw new Error('Invalid ModelItem content')
  if (item.role === 'tool' && typeof item.tool_call_id !== 'string') throw new Error('Invalid tool_call_id')
}

export function decodeAgentHistoryModelItem(json: string): ModelItem {
  if (boundedUtf8ByteCount(json, AGENT_HISTORY_ITEM_JSON_MAX_BYTES).exceeded) {
    throw new Error(`ModelItem JSON exceeds ${AGENT_HISTORY_ITEM_JSON_MAX_BYTES} bytes`)
  }
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('Invalid ModelItem JSON') }
  assertModelItem(value)
  return value
}

export function agentHistoryItemJson(item: ModelItem): string {
  return JSON.stringify(item)
}

export function agentHistoryItemSearchText(item: ModelItem): string {
  if (item.role === 'user') {
    return typeof item.content === 'string'
      ? item.content
      : item.content.map(block => block.type === 'text' ? block.text : `${block.name} ${block.mimeType}`).join('\n')
  }
  if (item.role === 'assistant') {
    const calls = item.tool_calls?.flatMap(call => [call.function.name, call.function.arguments]) ?? []
    return [item.content, item.reasoning_content, ...calls].filter((part): part is string => typeof part === 'string').join('\n')
  }
  return item.content
}

export function agentHistoryItemPreview(item: ModelItem): string {
  return codePointPrefix(agentHistoryItemSearchText(item), AGENT_HISTORY_ITEM_PREVIEW_MAX_CHARS)
}

export function agentHistoryItemRole(item: ModelItem): AgentHistoryItemRole {
  return item.role
}

export interface AgentHistoryTextChunk {
  readonly text: string
  readonly offset: number
  readonly nextOffset?: number
  readonly totalChars: number
}

export function readAgentHistoryText(text: string, offset: number, limit: number): AgentHistoryTextChunk {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative safe integer')
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive safe integer')
  let codePointOffset = 0
  let start = text.length
  let end = text.length
  for (let index = 0; index < text.length;) {
    if (codePointOffset === offset) start = index
    if (codePointOffset === offset + limit) end = index
    index += codePointWidthAt(text, index)
    codePointOffset += 1
  }
  if (codePointOffset === offset) start = text.length
  const totalChars = codePointOffset
  if (offset > totalChars) start = text.length
  return {
    text: text.slice(start, end),
    offset,
    nextOffset: offset + limit < totalChars ? offset + limit : undefined,
    totalChars,
  }
}
