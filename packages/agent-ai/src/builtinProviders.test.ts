import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_VENDOR_ID,
  GLM_VENDOR_ID,
  KIMI_VENDOR_ID,
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
  registerBuiltinProviders,
} from './builtinProviders'
import { DEEPSEEK_BASE_URL } from './deepseek'
import { KIMI_CN_BASE_URL } from './kimiRegion'
import { OpenAiCompatConfigError } from './openaiCompat'
import { createProviderRegistry } from './providerRegistry'
import { callModel } from './modelAdapter'

function jsonFetch(record: { url?: string; body?: Record<string, unknown> }): typeof fetch {
  return async (input, init) => {
    record.url = String(input)
    record.body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

describe('内置 provider 装配', () => {
  it('默认 registry 注册了四家', () => {
    expect(defaultProviderRegistry.resolve(DEEPSEEK_VENDOR_ID)).toBeDefined()
    expect(defaultProviderRegistry.resolve(GLM_VENDOR_ID)).toBeDefined()
    expect(defaultProviderRegistry.resolve(KIMI_VENDOR_ID)).toBeDefined()
    expect(defaultProviderRegistry.resolve(OPENAI_COMPAT_VENDOR_ID)).toBeDefined()
    expect(defaultProviderRegistry.resolve(GLM_VENDOR_ID)).not.toBe(
      defaultProviderRegistry.resolve(KIMI_VENDOR_ID),
    )
    // openai-compat 是真实注册的 adapter，不是靠 fallback 兜到 DeepSeek。
    expect(defaultProviderRegistry.resolve(OPENAI_COMPAT_VENDOR_ID)).not.toBe(
      defaultProviderRegistry.resolve(DEEPSEEK_VENDOR_ID),
    )
  })

  it('未知 vendor 回退到 DeepSeek adapter', () => {
    expect(defaultProviderRegistry.resolve('openai-compatible')).toBe(
      defaultProviderRegistry.resolve(DEEPSEEK_VENDOR_ID),
    )
  })

  it('未知 vendor 的请求仍按 DeepSeek 执行（含 user_id 上行）', async () => {
    const record: { url?: string; body?: Record<string, unknown> } = {}

    await callModel(
      {
        model: 'model',
        messages: [{ role: 'user', content: 'hi' }],
        // 运行期可能出现类型收窄不到的 vendor（历史会话、宿主配置），必须走回退而非抛错。
        settings: { vendor: 'not-a-vendor' } as unknown as { vendor: 'deepseek' },
        userId: 'wa_child_0123',
      },
      { apiKey: 'test-key', fetchImpl: jsonFetch(record), retry: { maxRetries: 0 } },
    )

    expect(record.url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`)
    expect(record.body).toMatchObject({ user_id: 'wa_child_0123' })
  })

  it('Kimi adapter 从通用 settings 投影 region', async () => {
    const record: { url?: string; body?: Record<string, unknown> } = {}

    await callModel(
      {
        model: 'kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        settings: { vendor: 'kimi', region: 'cn' },
        userId: 'wa_child_0123',
      },
      { apiKey: 'test-key', fetchImpl: jsonFetch(record), retry: { maxRetries: 0 } },
    )

    expect(record.url).toBe(`${KIMI_CN_BASE_URL}/chat/completions`)
    expect(record.body).not.toHaveProperty('region')
    expect(record.body).not.toHaveProperty('user_id')
  })

  it('registerBuiltinProviders 可以装配到独立 registry', () => {
    const registry = createProviderRegistry()

    expect(registry.resolve(DEEPSEEK_VENDOR_ID)).toBeUndefined()
    registerBuiltinProviders(registry)

    expect(registry.resolve(GLM_VENDOR_ID)).toBe(defaultProviderRegistry.resolve(GLM_VENDOR_ID))
    expect(registry.resolve(OPENAI_COMPAT_VENDOR_ID)).toBeDefined()
    // 独立实例没有配 fallback，未知 vendor 不会被兜到 DeepSeek。
    expect(registry.resolve('not-a-vendor')).toBeUndefined()
  })
})

describe('openai-compat adapter', () => {
  it('默认注册没有烘焙 baseUrl，发起调用时以配置错误拒绝', async () => {
    const call = callModel(
      {
        model: 'gateway-model',
        messages: [{ role: 'user', content: 'hi' }],
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID },
      },
      { apiKey: 'test-key', fetchImpl: jsonFetch({}) },
    )

    await expect(call).rejects.toBeInstanceOf(OpenAiCompatConfigError)
  })

  it('settings.baseUrl 覆盖装配层烘焙的默认接入点', async () => {
    const registry = createProviderRegistry()
    registry.register(
      OPENAI_COMPAT_VENDOR_ID,
      createOpenAiCompatAdapter({ baseUrl: 'https://assembly-default.example/v1' }),
    )
    const record: { url?: string; body?: Record<string, unknown> } = {}

    await registry.resolve(OPENAI_COMPAT_VENDOR_ID)!.call(
      {
        body: { model: 'gateway-model', messages: [{ role: 'user', content: 'hi' }] },
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID, baseUrl: 'https://per-request.example/v1' },
      },
      { apiKey: 'test-key', fetchImpl: jsonFetch(record), retry: { maxRetries: 0 } },
    )

    expect(record.url).toBe('https://per-request.example/v1/chat/completions')
  })

  it('没有 settings.baseUrl 时回退到装配层烘焙的默认接入点', async () => {
    const registry = createProviderRegistry()
    registry.register(
      OPENAI_COMPAT_VENDOR_ID,
      createOpenAiCompatAdapter({ baseUrl: 'https://assembly-default.example/v1' }),
    )
    const record: { url?: string; body?: Record<string, unknown> } = {}

    await registry.resolve(OPENAI_COMPAT_VENDOR_ID)!.call(
      {
        body: { model: 'gateway-model', messages: [{ role: 'user', content: 'hi' }] },
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID },
      },
      { apiKey: 'test-key', fetchImpl: jsonFetch(record), retry: { maxRetries: 0 } },
    )

    expect(record.url).toBe('https://assembly-default.example/v1/chat/completions')
  })

  it('能力描述是保守值：没有实测数据就不编 models 表', () => {
    const descriptor = defaultProviderRegistry.describe(OPENAI_COMPAT_VENDOR_ID)

    expect(descriptor).toEqual({ contextWindowTokens: 64_000, maxTurnTools: 128, models: {} })
  })
})
