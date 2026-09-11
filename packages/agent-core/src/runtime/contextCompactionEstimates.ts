// Token estimates and the serialization-free fast-path bound for context compaction.

import type { ModelItem } from '@einfach-agent/ai'
import { stringForStats } from './shared/preview'

// Inline image bytes are transport data, not prompt text. A fixed conservative allowance
// keeps them in the context budget without treating base64 expansion as millions of tokens.
const IMAGE_BLOCK_ESTIMATED_TOKENS = 4_096
const INLINE_IMAGE_DATA_PLACEHOLDER = '[inline image bytes omitted from text estimate]'

function imageCount(item: ModelItem): number {
  return item.role === 'user' && Array.isArray(item.content)
    ? item.content.filter((block) => block.type === 'image').length
    : 0
}

function modelItemEstimateValue(item: ModelItem): ModelItem {
  if (item.role !== 'user' || typeof item.content === 'string') return item
  return {
    ...item,
    content: item.content.map((block) => block.type !== 'image'
      || block.source.kind !== 'inline-base64'
      ? block
      : {
          ...block,
          source: { kind: 'inline-base64', data: INLINE_IMAGE_DATA_PLACEHOLDER },
        }),
  }
}

export interface ModelItemTextEstimate {
  readonly text: string
  readonly tokens: number
}

/** Serializes one budget projection while excluding inline transport bytes. */
export function modelItemTextEstimate(item: ModelItem): ModelItemTextEstimate {
  const text = stringForStats(modelItemEstimateValue(item))
  return {
    text,
    tokens: estimateTokensFromText(text) + imageCount(item) * IMAGE_BLOCK_ESTIMATED_TOKENS,
  }
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0
  const cjkChars = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0
  const otherChars = Math.max(0, text.length - cjkChars)
  return Math.ceil(cjkChars / 1.8 + otherChars / 4)
}

export function estimateItemTokens(item: ModelItem): number {
  return modelItemTextEstimate(item).tokens
}

export function estimateItemsTokens(items: readonly ModelItem[]): number {
  let total = 0
  for (const item of items) total += estimateItemTokens(item)
  return total
}

// This is a proof-preserving upper bound: when it fits, exact JSON serialization
// fits too. Infinity means callers must take the exact JSON.stringify path.
const JSON_MAX_ESCAPE_EXPANSION = 6
const CHARS_PER_TOKEN_ASCII = 4
const CHARS_PER_TOKEN_CJK = 1.8
const PRESCAN_TOKENS_PER_CHAR = Math.max(
  JSON_MAX_ESCAPE_EXPANSION / CHARS_PER_TOKEN_ASCII,
  1 / CHARS_PER_TOKEN_CJK,
)
const PRESCAN_SCALAR_CHARS = 24
const PRESCAN_MAX_DEPTH = 12
const PRESCAN_MAX_NODES = 20_000

interface PrescanState {
  nodes: number
}

function rawCharsOf(value: unknown, depth: number, state: PrescanState): number {
  state.nodes += 1
  if (state.nodes > PRESCAN_MAX_NODES || depth > PRESCAN_MAX_DEPTH) return Number.POSITIVE_INFINITY

  if (typeof value === 'string') return value.length + 2
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return PRESCAN_SCALAR_CHARS
  if (typeof value === 'undefined' || typeof value === 'function') return PRESCAN_SCALAR_CHARS
  if (typeof value !== 'object') return Number.POSITIVE_INFINITY
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return Number.POSITIVE_INFINITY

  if (Array.isArray(value)) {
    let total = 2 + Math.max(0, value.length - 1)
    for (const entry of value) {
      total += rawCharsOf(entry, depth + 1, state)
      if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY
    }
    return total
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  let total = 2 + Math.max(0, keys.length - 1)
  for (const key of keys) {
    total += key.length + 3
    total += rawCharsOf(record[key], depth + 1, state)
    if (!Number.isFinite(total)) return Number.POSITIVE_INFINITY
  }
  return total
}

export function estimateItemsTokensUpperBound(items: readonly ModelItem[]): number {
  const state: PrescanState = { nodes: 0 }
  let rawChars = 0
  let images = 0
  for (const item of items) {
    rawChars += rawCharsOf(modelItemEstimateValue(item), 0, state)
    images += imageCount(item)
    if (!Number.isFinite(rawChars)) return Number.POSITIVE_INFINITY
  }
  return Math.ceil(rawChars * PRESCAN_TOKENS_PER_CHAR) + items.length
    + images * IMAGE_BLOCK_ESTIMATED_TOKENS
}
