import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AgentHistoryError,
  agentHistoryItemPreview,
  agentHistoryItemRole,
  agentHistoryItemSearchText,
  decodeAgentHistoryModelItem,
  type AgentHistorySummary,
  type AgentHistoryTarget,
  type AgentHistoryWarning,
  type AgentItemUpsertMutationV1,
  type MaterializedAgentHistoryItemSummary,
} from '@einfach-agent/core/history'

import { readLegacyBoundedFile } from './legacyBoundedFile'
import { findLegacyRun, readLegacyChildIndex, type LegacyRunLocator } from './legacyChildIndex'
import { resolveLegacyTracePath } from './legacyChildPath'
import {
  assertLegacyContinuationSnapshot,
  assertLegacyDirectorySnapshot,
  type LegacyHistoryContinuation,
  type LegacyHistoryPage,
  type LegacyHistorySearchResult,
} from './legacyHistoryQuery'

export const LEGACY_CHILD_TRACE_MAX_BYTES = 2 * 1024 * 1024
export const LEGACY_CHILD_LIST_MAX_BYTES = 8 * 1024 * 1024
export const LEGACY_CHILD_MAX_DIRECTORY_ENTRIES = 256
const MAX_HISTORIES = 100
const PARTIAL: AgentHistoryWarning = {
  code: 'LEGACY_PARTIAL_HISTORY',
  message: 'This child trace is partial compatibility data, not a canonical rollout record.',
}
const TRUNCATED: AgentHistoryWarning = {
  code: 'OUTPUT_TRUNCATED', message: 'Legacy child discovery stopped at a hard read or discovery limit.',
}

export interface LegacyChildItem extends MaterializedAgentHistoryItemSummary { readonly modelItem: AgentItemUpsertMutationV1['item'] }
export interface LegacyChildRecord {
  readonly history: AgentHistorySummary
  readonly items: readonly LegacyChildItem[]
  readonly warnings: readonly AgentHistoryWarning[]
}
export type LegacyChildDiscoveryResult = LegacyHistoryPage<LegacyChildRecord>
export interface LegacyChildHistoryAdapter {
  listHistories(continuation?: LegacyHistoryContinuation): Promise<LegacyChildDiscoveryResult>
  listItems(target: AgentHistoryTarget): Promise<LegacyChildRecord | undefined>
  readItem(target: AgentHistoryTarget, itemId: string): Promise<LegacyChildItem | undefined>
  search(query: string, target?: AgentHistoryTarget, continuation?: LegacyHistoryContinuation): Promise<LegacyHistorySearchResult>
}

type ParsedLine = { kind: 'accepted'; timestamp: number; item: AgentItemUpsertMutationV1['item'] }
  | { kind: 'ignored' } | { kind: 'malformed' }

function parseTraceLine(line: string): ParsedLine {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (typeof value.timestamp !== 'string' || !Number.isSafeInteger(value.turn)) return { kind: 'malformed' }
    const timestamp = Date.parse(value.timestamp)
    if (!Number.isFinite(timestamp)) return { kind: 'malformed' }
    const item = decodeAgentHistoryModelItem(JSON.stringify(value.item))
    return item.role === 'assistant' || item.role === 'tool'
      ? { kind: 'accepted', timestamp, item }
      : { kind: 'ignored' }
  } catch { return { kind: 'malformed' } }
}

function project(target: Extract<AgentHistoryTarget, { kind: 'child' }>, text: string, fallbackTime: number): LegacyChildRecord {
  const historyId = `legacy-child:${target.conversationId}:${target.runId}:${target.agentPath}`
  const warnings: AgentHistoryWarning[] = [PARTIAL]
  const items: LegacyChildItem[] = []
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    const parsed = parseTraceLine(line)
    if (parsed.kind === 'ignored') return
    if (parsed.kind === 'malformed') {
      warnings.push({ code: 'MALFORMED_LEGACY_RECORD', message: `Skipped malformed legacy trace line ${index + 1}.` })
      return
    }
    items.push({
      historyId, itemId: `${historyId}:${index}`, materialized: true, itemOrdinal: items.length,
      createdAt: parsed.timestamp, role: agentHistoryItemRole(parsed.item),
      preview: agentHistoryItemPreview(parsed.item), pending: false, planStageId: null,
      deleted: false, modelItem: parsed.item,
    })
  })
  const times = items.map((item) => item.createdAt)
  return {
    history: {
      historyId, target, title: target.agentPath,
      createdAt: times[0] ?? fallbackTime, updatedAt: times.at(-1) ?? fallbackTime,
      status: 'legacy', complete: false, itemCount: items.length,
    },
    items, warnings,
  }
}

async function loadTrace(
  workspaceRoot: string,
  run: LegacyRunLocator,
  agentPath: string,
  cap = LEGACY_CHILD_TRACE_MAX_BYTES,
): Promise<{ record?: LegacyChildRecord; bytesRead: number; truncated: boolean }> {
  const tracePath = await resolveLegacyTracePath(run.runDirectory, agentPath, workspaceRoot)
  const file = await readLegacyBoundedFile(tracePath, Math.min(cap, LEGACY_CHILD_TRACE_MAX_BYTES))
  if (file.status === 'missing') return { bytesRead: 0, truncated: false }
  if (file.status === 'oversized') return { bytesRead: file.bytesRead, truncated: true }
  const target = { kind: 'child', ...run.target, agentPath } as const
  return { record: project(target, file.text, run.updatedAt), bytesRead: file.bytesRead, truncated: false }
}

export function createLegacyChildHistoryAdapter(legacyWorkspaceRoot?: string): LegacyChildHistoryAdapter {
  async function load(target: AgentHistoryTarget): Promise<LegacyChildRecord | undefined> {
    const { index, run } = await findLegacyRun(legacyWorkspaceRoot, target)
    if (!run || !index.workspaceRoot || target.kind !== 'child') return undefined
    return (await loadTrace(index.workspaceRoot, run, target.agentPath)).record
  }

  async function discover(continuation?: LegacyHistoryContinuation): Promise<LegacyChildDiscoveryResult> {
    const index = await readLegacyChildIndex(legacyWorkspaceRoot)
    assertLegacyContinuationSnapshot(continuation, index.indexSnapshot)
    const records: LegacyChildRecord[] = []
    if (index.truncated || !index.workspaceRoot) {
      return { records, warnings: index.warnings, truncated: index.truncated,
        continuation: index.continuation && { indexSnapshot: index.continuation.indexSnapshot, lastRunAgentKey: '' } }
    }
    let bytes = index.bytesRead
    let checked = 0
    let lastKey = continuation?.lastRunAgentKey ?? ''
    const resumed = lastKey ? parseRunAgentKey(lastKey) : undefined
    if (lastKey && !resumed) {
      throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', 'Invalid legacy child continuation key.')
    }
    for (const run of index.runs) {
      const directoryState = continuation?.directory
      const resumeRunKey = directoryState?.runKey ?? (resumed ? JSON.stringify(resumed.slice(0, 2)) : undefined)
      if (resumeRunKey && run.stableKey.localeCompare(resumeRunKey) < 0) continue
      if (directoryState && run.stableKey.localeCompare(directoryState.runKey) > 0) {
        throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', 'Legacy directory continuation run was not found.')
      }
      const directoryPath = join(run.runDirectory, 'traces')
      let snapshot: string
      try { snapshot = await traceDirectorySnapshot(directoryPath) } catch {
        if (directoryState?.runKey === run.stableKey) {
          throw new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'Legacy trace directory disappeared after cursor issue.')
        }
        continue
      }
      if (directoryState && run.stableKey === directoryState.runKey) {
        assertLegacyDirectorySnapshot(directoryState.snapshot, snapshot)
      }
      let directory
      try { directory = await opendir(directoryPath) } catch { continue }
      let offset = 0
      for await (const entry of directory) {
        offset += 1
        if (directoryState && run.stableKey === directoryState.runKey
          && offset <= directoryState.checkedOffset) continue
        if (records.length >= MAX_HISTORIES || bytes >= LEGACY_CHILD_LIST_MAX_BYTES) {
          return truncatedResult(records, index.warnings, index.indexSnapshot!, lastKey,
            { runKey: run.stableKey, checkedOffset: offset - 1, snapshot })
        }
        checked += 1
        if (!entry.isFile() || !entry.name.endsWith('.trace.jsonl')) {
          if (checked >= LEGACY_CHILD_MAX_DIRECTORY_ENTRIES) {
            return truncatedResult(records, index.warnings, index.indexSnapshot!, lastKey,
              { runKey: run.stableKey, checkedOffset: offset, snapshot })
          }
          continue
        }
        const agentPath = entry.name.slice(0, -'.trace.jsonl'.length)
        const key = JSON.stringify([run.target.conversationId, run.target.runId, agentPath])
        // Reserve the +1 probe byte so even oversized detection stays inside the total I/O budget.
        const remaining = LEGACY_CHILD_LIST_MAX_BYTES - bytes
        const loaded = await loadTrace(index.workspaceRoot, run, agentPath, Math.max(0, remaining - 1))
        bytes += loaded.bytesRead
        lastKey = key
        if (loaded.truncated) return truncatedResult(records, index.warnings, index.indexSnapshot!, key,
          { runKey: run.stableKey, checkedOffset: offset, snapshot })
        if (loaded.record) records.push(loaded.record)
        if (checked >= LEGACY_CHILD_MAX_DIRECTORY_ENTRIES) {
          return truncatedResult(records, index.warnings, index.indexSnapshot!, lastKey,
            { runKey: run.stableKey, checkedOffset: offset, snapshot })
        }
      }
    }
    records.sort((a, b) => b.history.updatedAt - a.history.updatedAt || a.history.historyId.localeCompare(b.history.historyId))
    return { records, warnings: index.warnings, truncated: false }
  }

  return {
    listHistories: discover,
    listItems: load,
    async readItem(target, itemId) { return (await load(target))?.items.find((item) => item.itemId === itemId) },
    async search(query, target, continuation) {
      const needle = query.trim().toLocaleLowerCase()
      if (!needle) return { hits: [], warnings: [], truncated: false }
      const page = target
        ? { records: [await load(target)].filter((record): record is LegacyChildRecord => Boolean(record)),
            warnings: [], truncated: false as const }
        : await discover(continuation)
      const warnings = [...page.warnings, ...page.records.flatMap((record) => record.warnings)]
      const hits = page.records.flatMap((record) => record.items.flatMap((item) => {
        const text = agentHistoryItemSearchText(item.modelItem)
        return text.toLocaleLowerCase().includes(needle)
          ? [{ ...item, target: record.history.target, snippet: text.slice(0, 1_000), rank: 0 }] : []
      }))
      return { hits, warnings, truncated: page.truncated, continuation: page.continuation }
    },
  }
}

function truncatedResult(
  records: readonly LegacyChildRecord[],
  warnings: readonly AgentHistoryWarning[],
  indexSnapshot: string,
  lastRunAgentKey: string,
  directory?: LegacyHistoryContinuation['directory'],
): LegacyChildDiscoveryResult {
  return { records, warnings: [...warnings, TRUNCATED], truncated: true,
    continuation: { indexSnapshot, lastRunAgentKey, directory } }
}

function parseRunAgentKey(key: string): readonly [string, string, string] | undefined {
  try {
    const value = JSON.parse(key) as unknown
    return Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'string')
      ? value as [string, string, string] : undefined
  } catch { return undefined }
}

async function traceDirectorySnapshot(path: string): Promise<string> {
  const value = await stat(path)
  if (!value.isDirectory()) throw new Error('Legacy trace locator is not a directory')
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`
}
