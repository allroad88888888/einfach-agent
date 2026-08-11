import type { ModelItem } from '@web-agent/ai'
import type { ContextCheckpoint } from '../state/contextCheckpoint.type'
import type { ConversationItem } from '../state/core.type'
import { contextCheckpointItem } from './contextDistillationPrompt'

export interface ContextCheckpointProjection {
  messages: ModelItem[]
  checkpoint: ContextCheckpoint | undefined
  invalidCheckpoint: boolean
}

/** Replaces only a verified historical prefix with its durable model checkpoint. */
export function projectContextCheckpoint(
  history: readonly ConversationItem[],
  checkpoint: ContextCheckpoint | undefined,
): ContextCheckpointProjection {
  if (!checkpoint) {
    return { messages: history.map((entry) => entry.item), checkpoint: undefined, invalidCheckpoint: false }
  }
  const count = checkpoint.coveredItemIds.length
  const matches = checkpoint.schemaVersion === 1
    && count > 0
    && count <= history.length
    && checkpoint.coveredItemIds.every((id, index) => history[index]?.id === id)
  if (!matches) {
    return { messages: history.map((entry) => entry.item), checkpoint: undefined, invalidCheckpoint: true }
  }
  return {
    messages: [contextCheckpointItem(checkpoint.summary), ...history.slice(count).map((entry) => entry.item)],
    checkpoint,
    invalidCheckpoint: false,
  }
}
