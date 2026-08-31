import { DEEPSEEK_BASE_URL, GLM_BASE_URL, KIMI_CN_BASE_URL } from '@einfach-agent/ai'
import { afterEach, describe, expect, it } from 'vitest'
import { replaceOpenAiCompatConnections } from './openAiCompatRegistry'
import { providerRouteSpec, providerTargetForRequest } from './providerRoute'

const profiles = [
  {
    id: 'looks-deepseek', kind: 'openai-compatible' as const,
    label: 'DeepSeek-R1', model: 'deepseek-v4-pro',
    baseUrl: 'https://third-party.example/deepseek/v1',
  },
  {
    id: 'looks-glm', kind: 'openai-compatible' as const,
    label: 'GLM Official', model: 'glm-5.3',
    baseUrl: 'https://glm-gateway.example/v1',
  },
  {
    id: 'looks-kimi', kind: 'openai-compatible' as const,
    label: 'Kimi', model: 'kimi-k3',
    baseUrl: 'https://kimi-proxy.example/v1',
  },
]

afterEach(() => replaceOpenAiCompatConnections([]))

describe('provider identity routing', () => {
  it.each(profiles)('profile label/model cannot promote $id to an official target', (profile) => {
    replaceOpenAiCompatConnections(profiles)

    expect(providerTargetForRequest(
      `${profile.baseUrl}/chat/completions`, 'POST', profile.id,
    )).toEqual({
      provider: 'openai-compat', scope: 'default', method: 'POST',
      path: '/chat/completions', connectionId: profile.id,
    })
  })

  it.each([
    [DEEPSEEK_BASE_URL, 'deepseek', 'default'],
    [GLM_BASE_URL, 'glm', 'default'],
    [KIMI_CN_BASE_URL, 'kimi', 'cn'],
  ] as const)('official origin %s keeps its immutable adapter identity', (origin, provider, scope) => {
    replaceOpenAiCompatConnections(profiles)

    expect(providerTargetForRequest(`${origin}/chat/completions`)).toEqual({
      provider, scope, method: 'POST', path: '/chat/completions',
    })
  })

  it('only the registered profile ID and exact URL pair is routable', () => {
    replaceOpenAiCompatConnections(profiles)
    const registeredUrl = `${profiles[0].baseUrl}/chat/completions`

    expect(() => providerTargetForRequest(registeredUrl, 'POST', 'missing'))
      .toThrow('模型请求目标未获允许')
    expect(() => providerTargetForRequest(
      `${profiles[0].baseUrl}/chat/completions/`, 'POST', profiles[0].id,
    )).toThrow('模型请求目标未获允许')
    expect(() => providerTargetForRequest(
      `${profiles[1].baseUrl}/chat/completions`, 'POST', profiles[0].id,
    )).toThrow('模型请求目标未获允许')
  })

  it('rejects mixed legacy/profile identity before transport', () => {
    replaceOpenAiCompatConnections(profiles)

    expect(() => providerTargetForRequest(
      `${profiles[0].baseUrl}/chat/completions`, 'POST', profiles[0].id, true,
    )).toThrow('模型请求目标未获允许')
  })
})

describe('DeepSeek file routing', () => {
  it('allows the fixed upload route and file-api delete IDs', () => {
    const upload = providerTargetForRequest(`${DEEPSEEK_BASE_URL}/files`)
    expect(upload).toEqual({
      provider: 'deepseek', scope: 'default', method: 'POST', path: '/files',
    })
    expect(providerRouteSpec(upload)).toEqual({
      bodyKind: 'multipart', url: `${DEEPSEEK_BASE_URL}/files`,
      maxResponseBytes: 4 * 1024 * 1024,
    })
    const deletion = providerTargetForRequest(
      `${DEEPSEEK_BASE_URL}/files/file-api-image_123.A-b`, 'DELETE',
    )
    expect(deletion).toEqual({
      provider: 'deepseek', scope: 'default', method: 'DELETE',
      path: '/files/file-api-image_123.A-b',
    })
    expect(providerRouteSpec(deletion)).toEqual({
      bodyKind: 'none', url: `${DEEPSEEK_BASE_URL}/files/file-api-image_123.A-b`,
      maxResponseBytes: 1024 * 1024,
    })
  })

  it.each([
    [`${DEEPSEEK_BASE_URL}/files`, 'DELETE'],
    [`${DEEPSEEK_BASE_URL}/files/file_123`, 'DELETE'],
    [`${DEEPSEEK_BASE_URL}/files/file-api-`, 'DELETE'],
    [`${DEEPSEEK_BASE_URL}/files/file-api-image/child`, 'DELETE'],
    [`${DEEPSEEK_BASE_URL}/files/file-api-image?query=1`, 'DELETE'],
    [`${DEEPSEEK_BASE_URL}/files/file-api-${'a'.repeat(248)}`, 'DELETE'],
    [`${DEEPSEEK_BASE_URL}/files/file-api-image`, 'POST'],
  ] as const)('rejects unsafe DeepSeek file route %s %s', (url, method) => {
    expect(() => providerTargetForRequest(url, method))
      .toThrow('模型请求目标未获允许')
  })
})
