export const MAX_DEEPSEEK_USER_ID_LENGTH = 512

/** Accepts only DeepSeek's opaque user identifier wire format. */
export function normalizeDeepSeekUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_DEEPSEEK_USER_ID_LENGTH) return undefined
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined
}
