import {
  agentHistoryItemPreview,
  agentHistoryItemRole,
  agentHistoryItemSearchText,
  type AgentHistorySummary,
  type AgentHistoryTarget,
  type AgentHistoryWarning,
  type AgentItemUpsertMutationV1,
  type MaterializedAgentHistoryItemSummary,
} from '@einfach-agent/core/history'
import {
  type RecoveryDriver,
  type RecoverySnapshotV1,
} from '@einfach-agent/core/state/persistence'
import type { LegacyHistorySearchResult } from './legacyHistoryQuery'

const PARTIAL_WARNING: AgentHistoryWarning = {
  code: 'LEGACY_PARTIAL_HISTORY',
  message: 'This history comes from a recovery snapshot, not the canonical rollout record.',
}

export interface LegacyRootItem extends MaterializedAgentHistoryItemSummary {
  readonly modelItem: AgentItemUpsertMutationV1['item']
}

export interface LegacyRootRecord {
  readonly history: AgentHistorySummary
  readonly items: readonly LegacyRootItem[]
  readonly warnings: readonly AgentHistoryWarning[]
}

export interface LegacyRootHistoryAdapter {
  listHistories(canonicalTargets?: readonly AgentHistoryTarget[]): Promise<readonly LegacyRootRecord[]>
  listItems(target: AgentHistoryTarget): Promise<LegacyRootRecord | undefined>
  readItem(target: AgentHistoryTarget, itemId: string): Promise<LegacyRootItem | undefined>
  search(query: string, target?: AgentHistoryTarget): Promise<LegacyHistorySearchResult>
}

function targetKey(target: AgentHistoryTarget): string {
  return target.kind === 'root'
    ? `root\0${target.conversationId}`
    : `child\0${target.conversationId}\0${target.runId}\0${target.agentPath}`
}

function project(snapshot: RecoverySnapshotV1): LegacyRootRecord {
  const target = { kind: 'root', conversationId: snapshot.sessionId } as const
  const historyId = `legacy-root:${snapshot.sessionId}`
  const items = snapshot.values.conversation.items.map((entry, itemOrdinal): LegacyRootItem => ({
    historyId,
    itemId: entry.id,
    materialized: true,
    itemOrdinal,
    createdAt: entry.createdAt,
    role: agentHistoryItemRole(entry.item),
    preview: agentHistoryItemPreview(entry.item),
    pending: entry.pending ?? false,
    planStageId: entry.planStageId ?? null,
    deleted: false,
    modelItem: entry.item,
  }))
  return {
    history: {
      historyId,
      target,
      title: snapshot.session.title,
      createdAt: snapshot.session.createdAt,
      updatedAt: snapshot.session.updatedAt,
      status: 'legacy',
      complete: false,
      itemCount: items.length,
    },
    items,
    warnings: [PARTIAL_WARNING],
  }
}

function sameTarget(left: AgentHistoryTarget, right: AgentHistoryTarget): boolean {
  return targetKey(left) === targetKey(right)
}

export function createLegacyRootHistoryAdapter(recovery: Pick<RecoveryDriver, 'listLatest'>): LegacyRootHistoryAdapter {
  async function records(): Promise<LegacyRootRecord[]> {
    return (await recovery.listLatest()).map(project)
  }

  async function find(target: AgentHistoryTarget): Promise<LegacyRootRecord | undefined> {
    if (target.kind !== 'root') return undefined
    return (await records()).find((record) => sameTarget(record.history.target, target))
  }

  return {
    async listHistories(canonicalTargets = []) {
      const canonical = new Set(canonicalTargets.map(targetKey))
      return (await records())
        .filter((record) => !canonical.has(targetKey(record.history.target)))
        .sort((left, right) => right.history.updatedAt - left.history.updatedAt
          || left.history.historyId.localeCompare(right.history.historyId))
    },
    listItems: find,
    async readItem(target, itemId) {
      return (await find(target))?.items.find((item) => item.itemId === itemId)
    },
    async search(query, target) {
      const needle = query.trim().toLocaleLowerCase()
      if (!needle) return { hits: [], warnings: [], truncated: false }
      const targeted = target ? await find(target) : undefined
      const source = target ? (targeted ? [targeted] : []) : await records()
      const hits = source.flatMap((record) => record?.items.flatMap((item) => {
        const text = agentHistoryItemSearchText(item.modelItem)
        if (!text.toLocaleLowerCase().includes(needle)) return []
        return [{ ...item, target: record.history.target, snippet: text.slice(0, 1_000), rank: 0 }]
      }) ?? [])
      return { hits, warnings: source.flatMap((record) => record?.warnings ?? []), truncated: false }
    },
  }
}
