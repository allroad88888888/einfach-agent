import type { ModelItem } from '@einfach-agent/ai'
import type { ContextSummaryRequest } from '../tools/contextCompaction'

export function buildContextDistillationMessages(
  stablePrefix: readonly ModelItem[],
  transcript: readonly ModelItem[],
  policy: ContextSummaryRequest,
): ModelItem[] {
  return [
    ...stablePrefix,
    { role: 'system', content: policy.instructions },
    ...transcript,
    { role: 'user', content: policy.request },
  ]
}

export function contextCheckpointItem(summary: string): ModelItem {
  return {
    role: 'system',
    content: `Runtime context checkpoint. Use this as the authoritative summary of earlier conversation; continue with later messages normally.\n\n${summary}`,
  }
}
