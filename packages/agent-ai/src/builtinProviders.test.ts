import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  DEEPSEEK_VENDOR_ID,
  GLM_VENDOR_ID,
  KIMI_VENDOR_ID,
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
  registerBuiltinProviders,
} from './builtinProviders'
import { DEEPSEEK_BASE_URL, type DeepSeekReasoningEffort } from './deepseek'
import { GLM_BASE_URL } from './glm'
import { KIMI_CN_BASE_URL } from './kimiRegion'
import { OpenAiCompatConfigError } from './openaiCompat'
import { createProviderRegistry, type ProviderSettings } from './providerRegistry'
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
  it('DeepSeek reasoning_effort 只允许 high 与 max', () => {
    expectTypeOf<DeepSeekReasoningEffort>().toEqualTypeOf<'high' | 'max'>()
  })

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

  it.each([
    {
      vendor: DEEPSEEK_VENDOR_ID, model: 'deepseek-v4-pro', url: DEEPSEEK_BASE_URL,
      thinking: { type: 'enabled' as const },
      settings: { reasoning_effort: 'high' }, expected: { reasoning_effort: 'high' },
      userId: 'wa_child_0123', hasUserId: true,
    },
    {
      vendor: GLM_VENDOR_ID, model: 'glm-5.2', url: GLM_BASE_URL,
      thinking: { type: 'enabled' as const },
      settings: { reasoning_effort: 'max' }, expected: { reasoning_effort: 'max' },
      userId: 'wa_child_0123', hasUserId: false,
    },
    {
      vendor: KIMI_VENDOR_ID, model: 'kimi-k2.6', url: KIMI_CN_BASE_URL,
      thinking: { type: 'enabled' as const },
      settings: { region: 'cn' }, expected: {}, userId: 'wa_child_0123', hasUserId: false,
    },
  ])('官方 $vendor identity 决定 adapter 与私有投影', async (entry) => {
    const record: { url?: string; body?: Record<string, unknown> } = {}
    await callModel(
      {
        model: entry.model,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: entry.thinking,
        settings: { vendor: entry.vendor, ...entry.settings },
        userId: entry.userId,
      },
      { apiKey: 'test-key', fetchImpl: jsonFetch(record), retry: { maxRetries: 0 } },
    )

    expect(record.url).toBe(`${entry.url}/chat/completions`)
    expect(record.body).toMatchObject(entry.expected)
    if (entry.hasUserId) expect(record.body).toHaveProperty('user_id', entry.userId)
    else expect(record.body).not.toHaveProperty('user_id')
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

  it('没有装配层登记时，不能用 settings.baseUrl 绕过', async () => {
    const adapter = createOpenAiCompatAdapter()
    let fetched = 0

    await expect(adapter.call(
      {
        body: { model: 'gateway-model', messages: [] },
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID, baseUrl: 'https://smuggled.example/v1' },
      },
      {
        apiKey: 'test-key',
        fetchImpl: (async () => { fetched += 1; return new Response() }) as typeof fetch,
      },
    )).rejects.toBeInstanceOf(OpenAiCompatConfigError)
    expect(fetched).toBe(0)
  })

  it('忽略会话 settings.baseUrl，只使用装配层登记的 legacy 接入点', async () => {
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

    expect(record.url).toBe('https://assembly-default.example/v1/chat/completions')
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

  it('CLI-style plain fetch 不会接收 legacy 内部身份标记', async () => {
    const registry = createProviderRegistry()
    registry.register(
      OPENAI_COMPAT_VENDOR_ID,
      createOpenAiCompatAdapter({ baseUrl: 'https://legacy.example/v1' }),
    )
    let headers = new Headers()

    await registry.resolve(OPENAI_COMPAT_VENDOR_ID)!.call(
      {
        body: { model: 'gateway-model', messages: [] },
        settings: { vendor: OPENAI_COMPAT_VENDOR_ID },
      },
      {
        apiKey: 'test-key', retry: { maxRetries: 0 },
        fetchImpl: (async (_input, init) => {
          headers = new Headers(init?.headers)
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        }) as typeof fetch,
      },
    )

    expect([...headers.keys()].filter((name) => name.startsWith('x-web-agent'))).toEqual([])
  })

  it('global fetch 不会接收 legacy 内部身份标记', async () => {
    const adapter = createOpenAiCompatAdapter({ baseUrl: 'https://legacy.example/v1' })
    let headers = new Headers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      headers = new Headers(init?.headers)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })

    try {
      await adapter.call(
        {
          body: { model: 'gateway-model', messages: [] },
          settings: { vendor: OPENAI_COMPAT_VENDOR_ID },
        },
        { apiKey: 'test-key', retry: { maxRetries: 0 } },
      )
    } finally {
      fetchSpy.mockRestore()
    }

    expect([...headers.keys()].filter((name) => name.startsWith('x-web-agent'))).toEqual([])
  })

  it('profile resolver remains authoritative without leaking connectionId to plain fetch', async () => {
    const registry = createProviderRegistry()
    registry.register(OPENAI_COMPAT_VENDOR_ID, createOpenAiCompatAdapter({
      baseUrl: 'https://legacy.example/v1',
      connectionBaseUrl: (id) => id === 'profile-a' ? 'https://profile.example/v1' : undefined,
    }))
    const seen: { url?: string; localHeaders?: string[] } = {}

    await registry.resolve(OPENAI_COMPAT_VENDOR_ID)!.call(
      {
        body: { model: 'model', messages: [] },
        settings: {
          vendor: OPENAI_COMPAT_VENDOR_ID,
          connectionId: 'profile-a',
          baseUrl: 'https://smuggled.example/v1',
        } as ProviderSettings & { connectionId: string },
      },
      {
        apiKey: 'test-key', retry: { maxRetries: 0 },
        fetchImpl: (async (input, init) => {
          seen.url = String(input)
          seen.localHeaders = [...new Headers(init?.headers).keys()]
            .filter((name) => name.startsWith('x-web-agent'))
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        }) as typeof fetch,
      },
    )

    expect(seen).toEqual({
      url: 'https://profile.example/v1/chat/completions',
      localHeaders: [],
    })
  })

  it('能力描述是保守值：没有实测数据就不编 models 表', () => {
    const descriptor = defaultProviderRegistry.describe(OPENAI_COMPAT_VENDOR_ID)

    expect(descriptor).toEqual({ contextWindowTokens: 64_000, maxTurnTools: 128, models: {} })
  })
})
