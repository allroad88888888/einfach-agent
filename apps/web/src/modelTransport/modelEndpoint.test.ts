import { DEEPSEEK_BASE_URL, GLM_BASE_URL } from '@web-agent/ai'
import { describe, expect, it } from 'vitest'
import { modelProviderForChatRequest } from './modelEndpoint'

describe('model endpoint allowlist', () => {
  it.each([
    [`${DEEPSEEK_BASE_URL}/chat/completions`, 'deepseek'],
    [`${GLM_BASE_URL}/chat/completions`, 'glm'],
  ] as const)('maps the fixed %s endpoint to %s', (url, provider) => {
    expect(modelProviderForChatRequest(url)).toBe(provider)
  })

  it.each([
    `${DEEPSEEK_BASE_URL}/chat/completions/`,
    `${DEEPSEEK_BASE_URL}/v1/chat/completions`,
    'https://untrusted.example/chat/completions',
  ])('rejects an endpoint outside the exact allowlist: %s', (url) => {
    expect(() => modelProviderForChatRequest(url)).toThrow('模型请求目标未获允许')
  })
})
