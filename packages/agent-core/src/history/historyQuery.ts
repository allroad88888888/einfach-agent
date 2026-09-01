import type { AgentHistoryTarget } from './agentHistoryTarget'

export const AGENT_HISTORY_LIST_DEFAULT_LIMIT = 20
export const AGENT_HISTORY_LIST_MAX_LIMIT = 100
export const AGENT_HISTORY_SEARCH_DEFAULT_LIMIT = 20
export const AGENT_HISTORY_SEARCH_MAX_LIMIT = 50
export const AGENT_HISTORY_ITEM_PREVIEW_MAX_CHARS = 2_000
export const AGENT_HISTORY_READ_DEFAULT_LIMIT = 20_000
export const AGENT_HISTORY_READ_MAX_LIMIT = 20_000
export const AGENT_HISTORY_SEARCH_QUERY_MAX_CHARS = 1_000
export const AGENT_HISTORY_SEARCH_SNIPPET_MAX_CHARS = 1_000
export const AGENT_HISTORY_PAGE_MAX_CHARS = 100_000

export type AgentHistoryCursor = string
export type AgentHistoryStatus =
  | 'idle' | 'running' | 'awaiting_tool' | 'waiting_user'
  | 'waiting_confirmation' | 'waiting_plan_approval' | 'interrupted'
  | 'done' | 'stopped' | 'error' | 'legacy'
export type AgentHistoryItemRole = 'system' | 'user' | 'assistant' | 'tool'

export type AgentHistoryWarningCode =
  | 'LEGACY_PARTIAL_HISTORY' | 'MALFORMED_LEGACY_RECORD'
  | 'PROJECTION_LAG' | 'SEARCH_INDEX_LAG' | 'SEARCH_INDEX_UNAVAILABLE'
  | 'OUTPUT_TRUNCATED'
export interface AgentHistoryWarning {
  readonly code: AgentHistoryWarningCode
  readonly message: string
}

export const AGENT_HISTORY_ERROR_CODES = [
  'AGENT_HISTORY_UNAVAILABLE',
  'AGENT_HISTORY_INVALID_CURSOR',
  'AGENT_HISTORY_CURSOR_STALE',
  'AGENT_HISTORY_NOT_FOUND',
  'AGENT_HISTORY_ITEM_NOT_FOUND',
  'AGENT_HISTORY_ITEM_DELETED',
  'AGENT_HISTORY_SOURCE_CORRUPT',
] as const

export type AgentHistoryErrorCode = (typeof AGENT_HISTORY_ERROR_CODES)[number]

export function isAgentHistoryErrorCode(value: unknown): value is AgentHistoryErrorCode {
  return typeof value === 'string'
    && (AGENT_HISTORY_ERROR_CODES as readonly string[]).includes(value)
}

export class AgentHistoryError extends Error {
  readonly code: AgentHistoryErrorCode
  constructor(code: AgentHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentHistoryError'
    this.code = code
  }
}

export interface AgentHistorySummary {
  readonly historyId: string
  readonly target: AgentHistoryTarget
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly status: AgentHistoryStatus
  readonly complete: boolean
  /** Count of materialized, non-deleted items. */
  readonly itemCount: number
}

interface AgentHistoryItemIdentity {
  readonly historyId: string
  readonly itemId: string
  readonly pending: boolean
  readonly planStageId: string | null
  readonly deleted: boolean
}

export interface MaterializedAgentHistoryItemSummary extends AgentHistoryItemIdentity {
  readonly materialized: true
  readonly itemOrdinal: number
  readonly createdAt: number
  readonly role: AgentHistoryItemRole
  readonly preview: string
}

export interface UnknownAgentHistoryItemTombstoneSummary extends AgentHistoryItemIdentity {
  readonly materialized: false
  readonly itemOrdinal: null
  readonly createdAt: null
  readonly role: null
  readonly preview: ''
  readonly pending: false
  readonly planStageId: null
  readonly deleted: true
}

export type AgentHistoryItemSummary =
  | MaterializedAgentHistoryItemSummary
  | UnknownAgentHistoryItemTombstoneSummary

export interface AgentHistorySearchHit extends MaterializedAgentHistoryItemSummary {
  readonly target: AgentHistoryTarget
  readonly snippet: string
  readonly rank: number
}

export interface ListAgentHistoriesInput {
  readonly target?: AgentHistoryTarget
  readonly statuses?: readonly AgentHistoryStatus[]
  readonly cursor?: AgentHistoryCursor
  readonly limit?: number
}
export interface ListAgentHistoriesResult {
  readonly histories: readonly AgentHistorySummary[]
  readonly nextCursor?: AgentHistoryCursor
  readonly warnings: readonly AgentHistoryWarning[]
}

export interface ListAgentHistoryItemsInput {
  readonly target: AgentHistoryTarget
  readonly cursor?: AgentHistoryCursor
  readonly limit?: number
  readonly includeDeleted?: boolean
  /** Providers normalize this filter by sorting and removing duplicates before cursor binding. */
  readonly roles?: readonly AgentHistoryItemRole[]
}
export interface ListAgentHistoryItemsResult {
  readonly history: AgentHistorySummary
  readonly items: readonly AgentHistoryItemSummary[]
  readonly nextCursor?: AgentHistoryCursor
  readonly warnings: readonly AgentHistoryWarning[]
}

export interface ReadAgentHistoryItemInput {
  readonly target: AgentHistoryTarget
  readonly itemId: string
  readonly offset?: number
  readonly limit?: number
}
export interface ReadAgentHistoryItemResult {
  readonly item: MaterializedAgentHistoryItemSummary
  readonly text: string
  readonly offset: number
  readonly nextOffset?: number
  readonly totalChars: number
  readonly warnings: readonly AgentHistoryWarning[]
}

export interface SearchAgentHistoriesInput {
  readonly query: string
  readonly target?: AgentHistoryTarget
  readonly roles?: readonly AgentHistoryItemRole[]
  readonly cursor?: AgentHistoryCursor
  readonly limit?: number
}
export interface SearchAgentHistoriesResult {
  readonly hits: readonly AgentHistorySearchHit[]
  readonly nextCursor?: AgentHistoryCursor
  readonly warnings: readonly AgentHistoryWarning[]
}

export interface AgentHistoryCapability {
  listHistories(input: ListAgentHistoriesInput): Promise<ListAgentHistoriesResult>
  listItems(input: ListAgentHistoryItemsInput): Promise<ListAgentHistoryItemsResult>
  readItem(input: ReadAgentHistoryItemInput): Promise<ReadAgentHistoryItemResult>
  search(input: SearchAgentHistoriesInput): Promise<SearchAgentHistoriesResult>
}

export interface AgentHistoryCapabilityProvider {
  forContext(input: { readonly legacyWorkspaceRoot?: string }): AgentHistoryCapability
}
