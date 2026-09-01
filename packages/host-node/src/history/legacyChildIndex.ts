import { createHash } from 'node:crypto'

import type { AgentHistoryTarget, AgentHistoryWarning } from '@einfach-agent/core/history'

import { readLegacyBoundedFile } from './legacyBoundedFile'
import { resolveLegacyRunIndexPath, resolveLegacyRunLocator } from './legacyChildPath'

export const LEGACY_RUN_INDEX_MAX_BYTES = 512 * 1024

function indexSnapshot(fileSnapshot: string, text: string): string {
  return `${fileSnapshot}:${createHash('sha256').update(text).digest('base64url')}`
}

export interface LegacyRunLocator {
  readonly target: Pick<Extract<AgentHistoryTarget, { kind: 'child' }>, 'conversationId' | 'runId'>
  readonly runDirectory: string
  readonly updatedAt: number
  readonly stableKey: string
}

export interface LegacyChildIndexResult {
  readonly runs: readonly LegacyRunLocator[]
  readonly warnings: readonly AgentHistoryWarning[]
  readonly truncated: boolean
  readonly continuation?: { readonly indexSnapshot: string; readonly lastRunKey: string }
  readonly bytesRead: number
  readonly workspaceRoot?: string
  readonly indexSnapshot?: string
}

function warning(message: string): AgentHistoryWarning {
  return { code: 'MALFORMED_LEGACY_RECORD', message }
}

function rawRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

export async function readLegacyChildIndex(legacyWorkspaceRoot?: string): Promise<LegacyChildIndexResult> {
  if (!legacyWorkspaceRoot) return { runs: [], warnings: [], truncated: false, bytesRead: 0 }
  const { workspaceRoot, runIndexPath } = await resolveLegacyRunIndexPath(legacyWorkspaceRoot)
  const file = await readLegacyBoundedFile(runIndexPath, LEGACY_RUN_INDEX_MAX_BYTES)
  if (file.status === 'missing') return { runs: [], warnings: [], truncated: false, bytesRead: 0, workspaceRoot }
  if (file.status === 'oversized') {
    return {
      runs: [], bytesRead: file.bytesRead, workspaceRoot, truncated: true,
      warnings: [{ code: 'OUTPUT_TRUNCATED', message: 'Legacy runs index exceeds its bounded read limit.' }],
      continuation: { indexSnapshot: file.snapshot, lastRunKey: '' },
      indexSnapshot: file.snapshot,
    }
  }
  const latest = new Map<string, LegacyRunLocator>()
  const warnings: AgentHistoryWarning[] = []
  const lines = file.text.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    const record = rawRecord(line)
    if (typeof record?.conversationId !== 'string' || typeof record.runId !== 'string'
      || typeof record.archiveBasePath !== 'string') {
      warnings.push(warning(`Skipped malformed legacy runs index line ${index + 1}.`)); continue
    }
    try {
      const conversationId = record.conversationId
      const runId = record.runId
      const stableKey = JSON.stringify([conversationId, runId])
      const runDirectory = await resolveLegacyRunLocator({
        workspaceRoot, conversationId, runId, archiveBasePath: record.archiveBasePath,
      })
      const parsed = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : 0
      latest.set(stableKey, {
        target: { conversationId, runId }, runDirectory, stableKey,
        updatedAt: Number.isFinite(parsed) ? parsed : 0,
      })
    } catch {
      warnings.push(warning(`Skipped legacy runs index line ${index + 1} with an invalid archive locator.`))
    }
  }
  const runs = [...latest.values()].sort((a, b) => a.stableKey.localeCompare(b.stableKey))
  return {
    runs, warnings, truncated: false, bytesRead: file.bytesRead, workspaceRoot,
    indexSnapshot: indexSnapshot(file.snapshot, file.text),
  }
}

export async function findLegacyRun(
  legacyWorkspaceRoot: string | undefined,
  target: AgentHistoryTarget,
): Promise<{ readonly index: LegacyChildIndexResult; readonly run?: LegacyRunLocator }> {
  const index = await readLegacyChildIndex(legacyWorkspaceRoot)
  if (target.kind !== 'child') return { index }
  return {
    index,
    run: index.runs.find((candidate) => candidate.target.conversationId === target.conversationId
      && candidate.target.runId === target.runId),
  }
}
