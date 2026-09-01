import {
  AgentHistoryError, agentHistoryItemJson, readAgentHistoryText,
  type AgentHistoryCapability, type AgentHistoryCapabilityProvider, type AgentHistoryTarget,
  type AgentHistoryWarning, type ListAgentHistoriesInput, type ListAgentHistoryItemsInput,
  type ReadAgentHistoryItemInput, type SearchAgentHistoriesInput,
} from '@einfach-agent/core/history'
import type { AgentRolloutDriver } from '@einfach-agent/core/history'
import type { RecoveryDriver, SqlExecutor } from '@einfach-agent/core/state/persistence'
import { createRolloutQueryRepository } from '../rollout/queryRepository'
import { createAgentHistorySearchIndex } from '../rollout/searchIndex'
import { createLegacyChildHistoryAdapter } from './legacyChildHistory'
import { createLegacyRootHistoryAdapter } from './legacyRootHistory'
import { decodeHistoryServiceCursor, encodeHistoryServiceCursor, type LegacyCursorFilters } from './historyServiceCursor'
import { assertHistoryEnvelope, fitHistoryPage } from './historyPageBudget'
import { fitCanonicalWarnings } from './historyCanonicalBudget'
import { normalizeHistoryItemsInput, normalizeHistoryListInput, normalizeHistoryReadInput,
  normalizeHistorySearchInput } from './historyInput'

export interface NodeAgentHistoryProviderOptions {
  readonly executor: SqlExecutor
  readonly agentRollout: Pick<AgentRolloutDriver, 'reconcile'>
  readonly recovery: Pick<RecoveryDriver, 'listLatest'>
}
const TRUNCATED: AgentHistoryWarning = { code: 'OUTPUT_TRUNCATED', message: 'Legacy history page exceeded the output limit' }
function publicItem<T>(item: T): T {
  const { modelItem: _modelItem, ...publicValue } = item as T & { readonly modelItem?: unknown }
  return publicValue as T
}

function projectionWarnings(result: Awaited<ReturnType<AgentRolloutDriver['reconcile']>>): AgentHistoryWarning[] {
  const source = result.histories.find((history) => history.warning?.kind === 'source')
  if (source) throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', source.warning!.message)
  return result.histories.some((history) => history.warning?.kind === 'projection')
    ? [{ code: 'PROJECTION_LAG', message: 'Canonical history projection has not caught up yet' }] : []
}
function withWarnings<T extends { readonly warnings: readonly AgentHistoryWarning[] }>(value: T,
  warnings: readonly AgentHistoryWarning[]): T {
  const result = { ...value, warnings: [...warnings, ...value.warnings] }
  assertHistoryEnvelope(result); return result
}

export function createNodeAgentHistoryProvider(options: NodeAgentHistoryProviderOptions): AgentHistoryCapabilityProvider {
  const canonical = createRolloutQueryRepository(options.executor)
  const searchIndex = createAgentHistorySearchIndex(options.executor)
  const root = createLegacyRootHistoryAdapter(options.recovery)
  return { forContext({ legacyWorkspaceRoot }): AgentHistoryCapability {
    const child = createLegacyChildHistoryAdapter(legacyWorkspaceRoot)
    async function reconcile(): Promise<AgentHistoryWarning[]> {
      try { return projectionWarnings(await options.agentRollout.reconcile()) } catch (cause) {
        if (cause instanceof AgentHistoryError && cause.code === 'AGENT_HISTORY_SOURCE_CORRUPT') throw cause
        throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', 'Canonical rollout reconciliation failed', { cause })
      }
    }
    async function canonicalExists(target: AgentHistoryTarget): Promise<boolean> {
      return (await canonical.listHistories({ target, limit: 1 })).histories.length === 1
    }
    async function legacyRecord(target: AgentHistoryTarget) {
      return target.kind === 'root' ? root.listItems(target) : child.listItems(target)
    }
    return {
      async listHistories(input: ListAgentHistoriesInput) {
        const warnings = await reconcile()
        const normalized = normalizeHistoryListInput(input)
        if (!normalized.target) {
          const result = await canonical.listHistories(normalized)
          return fitCanonicalWarnings(result, value => value.histories.length,
            limit => canonical.listHistories({ ...normalized, limit }), warnings)
        }
        if (await canonicalExists(normalized.target)) {
          const result = await canonical.listHistories(normalized)
          return fitCanonicalWarnings(result, value => value.histories.length,
            limit => canonical.listHistories({ ...normalized, limit }), warnings)
        }
        const filters: LegacyCursorFilters = { target: normalized.target }
        const offset = decodeHistoryServiceCursor(normalized.cursor, 'list', filters)
        const record = await legacyRecord(normalized.target)
        const allowed = !normalized.statuses?.length || normalized.statuses.includes('legacy')
        const values = record && allowed && offset === 0 ? [record.history] : []
        const result = { histories: values, warnings: [...warnings, ...(record?.warnings ?? [])] }
        assertHistoryEnvelope(result); return result
      },
      async listItems(input: ListAgentHistoryItemsInput) {
        const warnings = await reconcile()
        const normalized = normalizeHistoryItemsInput(input)
        if (await canonicalExists(normalized.target)) {
          const result = await canonical.listItems(normalized)
          return fitCanonicalWarnings(result, value => value.items.length,
            limit => canonical.listItems({ ...normalized, limit }), warnings)
        }
        const record = await legacyRecord(normalized.target)
        if (!record) throw new AgentHistoryError('AGENT_HISTORY_NOT_FOUND', 'History not found')
        const roles = [...new Set(normalized.roles ?? [])].sort()
        const filters: LegacyCursorFilters = { target: normalized.target, roles, includeDeleted: normalized.includeDeleted ?? false }
        const offset = decodeHistoryServiceCursor(normalized.cursor, 'items', filters)
        const candidates = record.items.filter((item) => !roles.length || roles.includes(item.role)).slice(offset)
        const limit = normalized.limit
        const page = candidates.slice(0, limit).map(publicItem); const hasMore = candidates.length > page.length
        const build = (count: number, truncated: boolean) => ({ history: record.history, items: page.slice(0, count),
          warnings: [...warnings, ...record.warnings, ...(truncated ? [TRUNCATED] : [])],
          ...((hasMore || truncated) && count ? { nextCursor: encodeHistoryServiceCursor('items', filters, offset + count) } : {}) })
        const count = fitHistoryPage(page, build)
        return build(count, count < page.length) as Awaited<ReturnType<AgentHistoryCapability['listItems']>>
      },
      async readItem(input: ReadAgentHistoryItemInput) {
        const warnings = await reconcile()
        const normalized = normalizeHistoryReadInput(input)
        if (await canonicalExists(normalized.target)) return withWarnings(await canonical.readItem(normalized), warnings)
        const record = await legacyRecord(normalized.target)
        if (!record) throw new AgentHistoryError('AGENT_HISTORY_NOT_FOUND', 'History not found')
        const item = record.items.find((candidate) => candidate.itemId === normalized.itemId)
        if (!item) throw new AgentHistoryError('AGENT_HISTORY_ITEM_NOT_FOUND', 'History item not found')
        const result = { item: publicItem(item), ...readAgentHistoryText(agentHistoryItemJson(item.modelItem), normalized.offset,
          normalized.limit), warnings: [...warnings, ...record.warnings] }
        assertHistoryEnvelope(result); return result
      },
      async search(input: SearchAgentHistoriesInput) {
        const warnings = await reconcile()
        const normalized = normalizeHistorySearchInput(input)
        if (!normalized.target || await canonicalExists(normalized.target)) {
          const result = await searchIndex.search(normalized)
          return fitCanonicalWarnings(result, value => value.hits.length,
            limit => searchIndex.search({ ...normalized, limit }), warnings)
        }
        const roles = [...new Set(normalized.roles ?? [])].sort(); const query = normalized.query
        const filters: LegacyCursorFilters = { target: normalized.target, query, roles }
        const offset = decodeHistoryServiceCursor(normalized.cursor, 'search', filters)
        const source = normalized.target.kind === 'root' ? await root.search(query, normalized.target)
          : await child.search(query, normalized.target)
        const candidates = source.hits.filter((hit) => !roles.length || roles.includes(hit.role)).slice(offset)
        const limit = normalized.limit; const page = candidates.slice(0, limit).map(publicItem); const hasMore = candidates.length > page.length
        const build = (count: number, truncated: boolean) => ({ hits: page.slice(0, count),
          warnings: [...warnings, ...source.warnings, ...(truncated ? [TRUNCATED] : [])],
          ...((hasMore || truncated) && count ? { nextCursor: encodeHistoryServiceCursor('search', filters, offset + count) } : {}) })
        const count = fitHistoryPage(page, build)
        return build(count, count < page.length) as Awaited<ReturnType<AgentHistoryCapability['search']>>
      },
    }
  } }
}
