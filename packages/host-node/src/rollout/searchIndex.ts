import { AgentHistoryError, type SearchAgentHistoriesInput,
  type SearchAgentHistoriesResult } from '@einfach-agent/core/history'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

import { queryAgentHistorySearch } from './searchQuery'
import { reconcileAgentHistorySearch, type SearchReconcilerOptions } from './searchReconciler'
import { derivedSearchFailure, isDerivedSearchFailure, MixedSearchIndexSqlError } from './searchIndexFailure'
import { dropAgentHistorySearchSchema, ensureAgentHistorySearchSchema,
  probeAgentHistorySearchSchema } from './searchSchema'

export interface AgentHistorySearchIndex {
  search(input: SearchAgentHistoriesInput): Promise<SearchAgentHistoriesResult>
  reconcile(): Promise<{ readonly available: boolean; readonly lagging: boolean; readonly eventsApplied: number }>
}
export function createAgentHistorySearchIndex(executor: SqlExecutor,
  options: SearchReconcilerOptions = {}): AgentHistorySearchIndex {
  const unavailable = () => ({ available: false as const, lagging: false, eventsApplied: 0, watermark: 0 })
  async function reconcileOnce() {
    const available = await ensureAgentHistorySearchSchema(executor)
    if (!available) return unavailable()
    const result = await reconcileAgentHistorySearch(executor, options)
    return { available: true, ...result }
  }
  async function rebuild() {
    try { await dropAgentHistorySearchSchema(executor) } catch { return false }
    return ensureAgentHistorySearchSchema(executor)
  }
  async function reconcile() {
    try { return await reconcileOnce() } catch (cause) {
      if (cause instanceof MixedSearchIndexSqlError) {
        try { await probeAgentHistorySearchSchema(executor) } catch { cause = derivedSearchFailure('Search state probe failed') }
      }
      if (!isDerivedSearchFailure(cause)) {
        if (cause instanceof AgentHistoryError) throw cause
        throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT',
          'Canonical history events cannot be indexed', { cause })
      }
      if (!await rebuild()) return unavailable()
      try { return await reconcileAgentHistorySearch(executor, options).then(result => ({ available: true, ...result })) }
      catch (retryCause) {
        if (retryCause instanceof MixedSearchIndexSqlError) {
          try { await probeAgentHistorySearchSchema(executor) } catch { return unavailable() }
        }
        if (isDerivedSearchFailure(retryCause)) return unavailable()
        if (retryCause instanceof AgentHistoryError) throw retryCause
        throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT',
          'Canonical history events cannot be indexed', { cause: retryCause })
      }
    }
  }
  async function classifyQueryFailure(cause: unknown): Promise<'derived' | never> {
    if (isDerivedSearchFailure(cause)) return 'derived'
    if (cause instanceof MixedSearchIndexSqlError) {
      try { await probeAgentHistorySearchSchema(executor) } catch { return 'derived' }
      throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', 'Canonical history search query failed', { cause })
    }
    throw cause
  }
  return { reconcile,
    async search(input) {
      let state = await reconcile()
      if (!state.available) return { hits: [], warnings: [{ code: 'SEARCH_INDEX_UNAVAILABLE',
        message: 'SQLite FTS5 is unavailable' }] }
      const runQuery = async () => {
        const eventRows = await executor.select<Array<{ count: unknown }>>('SELECT COUNT(*) count FROM agent_rollout_events')
        const eventCount = eventRows[0]?.count
        if (!Number.isSafeInteger(eventCount) || (eventCount as number) < 0) {
          throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', 'Canonical event snapshot is corrupt')
        }
        const warnings = state.lagging ? [{ code: 'SEARCH_INDEX_LAG' as const,
          message: 'History search index has not caught up yet' }] : []
        return queryAgentHistorySearch(executor, input,
          { eventCount: eventCount as number, watermark: state.watermark }, warnings)
      }
      try { return await runQuery() } catch (cause) {
        await classifyQueryFailure(cause)
        if (!await rebuild()) return { hits: [], warnings: [{ code: 'SEARCH_INDEX_UNAVAILABLE',
          message: 'SQLite FTS5 is unavailable' }] }
        state = await reconcile()
        if (!state.available) return { hits: [], warnings: [{ code: 'SEARCH_INDEX_UNAVAILABLE',
          message: 'SQLite FTS5 is unavailable' }] }
        try { return await runQuery() } catch (retryCause) {
          if (await classifyQueryFailure(retryCause) === 'derived') return { hits: [], warnings: [{
            code: 'SEARCH_INDEX_UNAVAILABLE', message: 'SQLite FTS5 is unavailable' }] }
          throw retryCause
        }
      }
    },
  }
}
