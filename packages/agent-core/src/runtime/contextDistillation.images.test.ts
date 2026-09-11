import type { ModelItem } from '@einfach-agent/ai'
import { describe, expect, it } from 'vitest'
import { contextInputBudgetTokens } from './contextBudget'
import { contextNeedsDistillation } from './contextDistillation'

function inlineImage(byteSize: number): ModelItem {
  return {
    role: 'user',
    content: [{
      type: 'image',
      source: { kind: 'inline-base64', data: 'A'.repeat(Math.ceil(byteSize / 3) * 4) },
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize,
      width: 1024,
      height: 768,
    }],
  }
}

describe('context distillation image budget', () => {
  const budget = contextInputBudgetTokens('openai-compat', 'vision-model', 8_000)

  it('does not count inline transport bytes as prompt text tokens', () => {
    // 192 KiB expands to 65,536 base64 characters/tokens-at-four-chars, above the
    // 50,880-token OpenAI-compatible budget under the old text-counting behavior.
    expect(contextNeedsDistillation([inlineImage(192 * 1024)], [], budget)).toBe(false)
  })

  it('still distills genuinely oversized user text', () => {
    expect(contextNeedsDistillation([{
      role: 'user', content: 'x'.repeat(budget * 4),
    }], [], budget)).toBe(true)
  })
})
