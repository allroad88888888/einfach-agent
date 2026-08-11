import type { ModelItem } from '@web-agent/ai'
import { estimateItemsTokens } from '../runtime/contextCompaction'
import { contextCheckpointItem } from '../runtime/contextDistillationPrompt'

/** Model-authored checkpoint for the append-only transcript of one child agent. */
export interface ChildContextCheckpoint {
  summary: string
  coveredMessages: readonly ModelItem[]
  sourceEstimatedTokens: number
}

export interface ChildContextProjection {
  messages: ModelItem[]
  checkpoint: ChildContextCheckpoint | undefined
  invalidCheckpoint: boolean
}

/** Projects a verified child-history prefix to its checkpoint without mutating history. */
export function projectChildContextCheckpoint(
  messages: readonly ModelItem[],
  checkpoint: ChildContextCheckpoint | undefined,
): ChildContextProjection {
  if (!checkpoint) return { messages: [...messages], checkpoint: undefined, invalidCheckpoint: false }
  const count = checkpoint.coveredMessages.length
  const matches = count > 0
    && count <= messages.length
    && checkpoint.coveredMessages.every((item, index) => messages[index] === item)
  if (!matches) return { messages: [...messages], checkpoint: undefined, invalidCheckpoint: true }
  return {
    messages: [contextCheckpointItem(checkpoint.summary), ...messages.slice(count)],
    checkpoint,
    invalidCheckpoint: false,
  }
}

/** Captures the exact history prefix replaced by a model-authored checkpoint. */
export function createChildContextCheckpoint(
  messages: readonly ModelItem[],
  summary: string,
): ChildContextCheckpoint {
  return {
    summary,
    coveredMessages: [...messages],
    sourceEstimatedTokens: estimateItemsTokens(messages),
  }
}
