import type { ModelChatResponse } from '@einfach-agent/ai'

function summaryText(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined
  const trimmed = content.trim()
  return trimmed || undefined
}

/** Returns the model's complete non-empty checkpoint response as context. */
export function parseContextDistillationResponse(response: ModelChatResponse): string | undefined {
  return summaryText(response.choices?.[0]?.message?.content)
}
