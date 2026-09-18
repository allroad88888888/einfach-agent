import type { ModelItem } from '@einfach-agent/ai'
import type { ConversationItem } from '../state/core.type'
import { contextCheckpointAtom, itemsAtom } from '../state/sessionAtoms'
import { setContextCheckpointOnSession } from '../state/sessionWriters'
import type { ContextCheckpointProjection } from './contextCheckpointProjection'
import { projectContextCheckpoint } from './contextCheckpointProjection'
import { createContextCompactionCapability } from './contextCompactionCapability'
import { estimateItemsTokens } from './contextCompactionEstimates'
import { contextNeedsDistillation } from './contextDistillation'
import { projectTimedToolResultOrphans } from './timedToolResultProjection'
import { dispatchTimedTools } from './timedDispatch'
import type { ToolLoopBase } from './toolLoopContracts'

/** Binds one compaction tool invocation to the main session's existing state/undo writer. */
export async function compactMainContext(base: ToolLoopBase, input: {
  history: readonly ConversationItem[]
  projection: ContextCheckpointProjection
  controls: readonly ModelItem[]
  tools: unknown
  inputBudgetTokens: number
}): Promise<boolean> {
  const session = base.core.getSessionStore(base.id)
  const previousCheckpoint = session.store.getter(contextCheckpointAtom)
  const source = [...input.history]
  const assertCurrent = () => {
    const current = session.store.getter(itemsAtom)
    if (!base.control.isCurrent() || !base.control.isRunning()
      || source.some((item, index) => current[index] !== item)
      || session.store.getter(contextCheckpointAtom) !== previousCheckpoint) {
      throw new Error('待压缩上下文已变化，摘要未提交。')
    }
  }
  const invocation = createContextCompactionCapability({
    stablePrefix: base.stablePrefix.items,
    transcript: input.projection.messages,
    settings: base.settings,
    apiKey: base.opts.apiKey,
    signal: base.opts.signal,
    fetchImpl: base.opts.fetchImpl,
    userId: base.modelUserId,
    assertCurrent,
    commit(summary) {
      const checkpoint = {
        schemaVersion: 1 as const,
        summary,
        coveredItemIds: source.map((item) => item.id),
        createdAt: Date.now(),
        sourceEstimatedTokens: estimateItemsTokens(input.projection.messages),
      }
      const projected = projectContextCheckpoint(session.store.getter(itemsAtom), checkpoint)
      const messages = projectTimedToolResultOrphans([
        ...base.stablePrefix.items, ...projected.messages, ...input.controls,
      ])
      if (projected.invalidCheckpoint || contextNeedsDistillation(messages, input.tools, input.inputBudgetTokens)) {
        throw new Error('上下文摘要仍超过本次请求预算；已保留原始历史，请缩小工具 schema 或重试。')
      }
      setContextCheckpointOnSession(session, checkpoint)
      return { coveredItems: source.length, sourceEstimatedTokens: checkpoint.sourceEstimatedTokens, summaryChars: summary.length }
    },
  })
  try {
    if (base.core.timedToolRegistrations('compact').length !== 1) {
      throw new Error('上下文压缩需要注册一个 compact 到点工具。')
    }
    const result = await dispatchTimedTools({
      base, request: { sessionId: base.id, timing: 'compact' }, contextCompaction: invocation.capability,
    })
    if (result.status !== 'dispatched') return false
    if (!invocation.committed) throw new Error('压缩工具未提交有效摘要；请检查工具结果或重试。')
    return true
  } finally {
    invocation.close()
  }
}
