// 登记式接入点在浏览器这一侧的两个后果：adapter 拿不拿得到 baseUrl，请求认不认得出来
// ---------------------------------------------------------------------------
// **安全判定不在这一侧**（后端的端点白名单才是），所以这里钉的不是「什么地址合规」，而是
// 「没登记时前端也发不出去」与「登记之后目标里仍然没有 origin」。
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEEPSEEK_BASE_URL,
  OPENAI_COMPAT_VENDOR_ID,
  defaultProviderRegistry,
} from '@einfach-agent/ai'
import { applyOpenAiCompatEndpoint, openAiCompatOrigin } from './openAiCompatEndpoint'
import { providerInputForFetch } from './providerFetch'
import { providerTargetForRequest } from './providerRoute'

const GATEWAY = 'https://gateway.example.com/v1'

/** 取当前注册的那个实例。registry「重复注册以最后一次为准」，所以每次都要重新取。 */
function openAiCompatAdapter() {
  const adapter = defaultProviderRegistry.resolve(OPENAI_COMPAT_VENDOR_ID)
  if (!adapter) throw new Error('openai-compat adapter 未注册')
  return adapter
}

/** 一次最小的 provider 请求；`vendor` 是 ProviderSettings 唯一的公共字段。 */
function request() {
  return { body: { model: 'x', messages: [] }, settings: { vendor: OPENAI_COMPAT_VENDOR_ID } }
}

afterEach(() => {
  // 模块级单值，用例之间必须归位，否则「没登记」那几条会被上一条用例的登记喂成绿的。
  applyOpenAiCompatEndpoint(undefined)
})

describe('没登记时', () => {
  it('openAiCompatOrigin 是 undefined', () => {
    expect(openAiCompatOrigin()).toBeUndefined()
  })

  it('adapter 在任何 fetch 之前就以 missing_base_url 拒绝（D4 的共形断言仍然成立）', async () => {
    applyOpenAiCompatEndpoint(undefined)
    const adapter = openAiCompatAdapter()
    let fetched = 0
    await expect(adapter.call(
      request(),
      { apiKey: 'k', fetchImpl: (() => { fetched += 1; throw new Error('不该发出去') }) as never },
    )).rejects.toThrow('missing_base_url')
    expect(fetched).toBe(0)
  })

  it('就算 URL 被拼出来了，前端也认不出这个目标——与后端同向 fail closed', () => {
    expect(() => providerTargetForRequest(`${GATEWAY}/chat/completions`))
      .toThrow('模型请求目标未获允许')
  })
})

describe('登记之后', () => {
  it('adapter 把请求拼到登记的接入点上', async () => {
    applyOpenAiCompatEndpoint(GATEWAY)
    const adapter = openAiCompatAdapter()
    const seen: string[] = []
    const fetchImpl = ((url: string) => {
      seen.push(url)
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ))
    }) as never

    await adapter.call(request(), { apiKey: 'k', fetchImpl })

    expect(seen).toEqual([`${GATEWAY}/chat/completions`])
  })

  it('那条 URL 被认成 openai-compat 目标，且目标里**没有 origin 字段**', () => {
    applyOpenAiCompatEndpoint(GATEWAY)

    const target = providerTargetForRequest(`${GATEWAY}/chat/completions`)

    expect(target).toEqual({
      provider: 'openai-compat',
      scope: 'default',
      method: 'POST',
      path: '/chat/completions',
    })
    // 整条信封里不该出现登记的那个域名：origin 由后端查表得出，调用方连表达它的字段都没有。
    const input = providerInputForFetch(`${GATEWAY}/chat/completions`, {
      method: 'POST',
      body: '{}',
    })
    expect(JSON.stringify(input.target)).not.toContain('gateway.example.com')
  })

  it('只认 chat 端点：/files、DELETE、带 query 的路径一律不认', () => {
    applyOpenAiCompatEndpoint(GATEWAY)
    for (const [url, method] of [
      [`${GATEWAY}/files`, 'POST'],
      [`${GATEWAY}/files/abc`, 'DELETE'],
      [`${GATEWAY}/embeddings`, 'POST'],
      [`${GATEWAY}/chat/completions/`, 'POST'],
      [`${GATEWAY}/chat/completions?stream=true`, 'POST'],
    ] as const) {
      expect(() => providerTargetForRequest(url, method)).toThrow('模型请求目标未获允许')
    }
  })

  it('登记一条内置厂商的域名时，请求仍算那一家——登记值顶不掉内置身份', () => {
    // 这是识别顺序的后果：前三家排在登记值前面。反过来的话，一条登记就能把 DeepSeek 的请求
    // 改判成 openai-compat，于是它会带着另一把 Key 发出去。
    applyOpenAiCompatEndpoint(DEEPSEEK_BASE_URL)
    expect(providerTargetForRequest(`${DEEPSEEK_BASE_URL}/chat/completions`).provider)
      .toBe('deepseek')
  })
})

describe('撤销登记', () => {
  it('把 adapter 换回零配置默认实例，而不是留着上一次的地址', async () => {
    applyOpenAiCompatEndpoint(GATEWAY)
    applyOpenAiCompatEndpoint(undefined)

    expect(openAiCompatOrigin()).toBeUndefined()
    const adapter = openAiCompatAdapter()
    await expect(adapter.call(
      request(),
      { apiKey: 'k', fetchImpl: (() => { throw new Error('不该发出去') }) as never },
    )).rejects.toThrow('missing_base_url')
  })
})
