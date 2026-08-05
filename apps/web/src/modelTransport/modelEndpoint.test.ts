import {
  DEEPSEEK_BASE_URL,
  GLM_BASE_URL,
  KIMI_CN_BASE_URL,
  KIMI_GLOBAL_BASE_URL,
} from '@web-agent/ai'
import { describe, expect, it } from 'vitest'
import { modelProviderForChatRequest } from './modelEndpoint'
import { providerTargetForRequest } from './providerRoute'

describe('model endpoint allowlist', () => {
  it.each([
    [`${DEEPSEEK_BASE_URL}/chat/completions`, 'deepseek'],
    [`${GLM_BASE_URL}/chat/completions`, 'glm'],
    [`${KIMI_CN_BASE_URL}/chat/completions`, 'kimi'],
  ] as const)('maps the fixed %s endpoint to %s', (url, provider) => {
    expect(modelProviderForChatRequest(url)).toBe(provider)
  })

  it('maps only fixed Kimi CN file routes', () => {
    expect(providerTargetForRequest(`${KIMI_CN_BASE_URL}/files`)).toEqual({
      provider: 'kimi', scope: 'cn', method: 'POST', path: '/files',
    })
    expect(providerTargetForRequest(
      `${KIMI_CN_BASE_URL}/files/file_123.A-b`,
      'DELETE',
    )).toEqual({
      provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/file_123.A-b',
    })
  })

  it.each([
    `${DEEPSEEK_BASE_URL}/chat/completions/`,
    `${DEEPSEEK_BASE_URL}/v1/chat/completions`,
    `${KIMI_GLOBAL_BASE_URL}/chat/completions`,
    `${KIMI_CN_BASE_URL}/files/../secret`,
    `${KIMI_CN_BASE_URL}/files/key?query=1`,
    'https://untrusted.example/chat/completions',
  ])('rejects an endpoint outside the exact allowlist: %s', (url) => {
    expect(() => providerTargetForRequest(url)).toThrow('模型请求目标未获允许')
  })

  it('does not treat an allowed file route as chat', () => {
    expect(() => modelProviderForChatRequest(`${KIMI_CN_BASE_URL}/files`))
      .toThrow('模型请求目标未获允许')
  })
})
