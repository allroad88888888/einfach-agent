import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEEPSEEK_BASE_URL, KIMI_CN_BASE_URL, KIMI_GLOBAL_BASE_URL } from '@einfach-agent/ai'
import { describe, expect, it, vi } from 'vitest'
import type { ServerInvokeTokenEnvironment } from '../host/serverInvokeToken'
import { createServerModelFetch, MODEL_ROUTE_PATH } from './serverModelTransport'

const chatUrl = `${DEEPSEEK_BASE_URL}/chat/completions`

/** 从不读写真实 window：token 环境固定给一个假值（同 serverInvoke.test.ts 的写法）。 */
function tokenEnv(token: string | undefined): ServerInvokeTokenEnvironment {
  return {
    location: { href: token ? `http://127.0.0.1:4765/?token=${token}` : 'http://127.0.0.1:4765/' },
    history: { state: null, replaceState: vi.fn() },
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
  }
}

function stubFetch(response: Response) {
  return vi.fn(async (_input: string, _init: RequestInit) => response)
}

type StubFetch = ReturnType<typeof stubFetch>

function callOf(fetchMock: StubFetch): [string, RequestInit] {
  const call = fetchMock.mock.calls[0]
  expect(call).toBeDefined()
  return call as [string, RequestInit]
}

function envelopeOf(fetchMock: StubFetch): unknown {
  return JSON.parse(String(callOf(fetchMock)[1].body))
}

describe('createServerModelFetch', () => {
  it('把规范信封 POST 到 /api/model/request 并带上 Bearer token', async () => {
    const fetchMock = stubFetch(new Response('ok'))
    await createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('abc123') })(
      chatUrl,
      { method: 'POST', headers: { authorization: 'Bearer browser-key' }, body: '{"stream":true}' },
    )

    const [url, init] = callOf(fetchMock)
    // 逐字写死，不拿被测模块自己的常量去比自己——那样两边一起改还是绿的。这个字面量必须与
    // `apps/server/src/modelRoutePath.ts` 的 `MODEL_ROUTE_PATH` 一致。
    expect(url).toBe('/api/model/request')
    expect(MODEL_ROUTE_PATH).toBe('/api/model/request')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer abc123' })
    expect(init.credentials).toBe('omit')
    expect(init.cache).toBe('no-store')
    expect(init.redirect).toBe('error')
    // 浏览器侧那个 `Bearer browser-key` 不该被转发到任何地方：Key 只由本机后端从配置读。
    expect(envelopeOf(fetchMock)).toEqual({
      target: { provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions' },
      body: { kind: 'json', json: '{"stream":true}' },
      requestId: expect.any(String),
    })
  })

  it('没有 token 时不带 authorization 头，请求照发（让 server 给出准确的 401）', async () => {
    const fetchMock = stubFetch(new Response('ok'))
    // 不传 tokenEnvironment：走生产默认值（真实 window），jsdom 的地址栏里没有 token。
    await createServerModelFetch({ fetch: fetchMock })(chatUrl, { body: '{}' })

    expect(callOf(fetchMock)[1].headers).toEqual({ 'content-type': 'application/json' })
  })

  it('AbortSignal 原样交给 fetch（取消靠的是这一次 HTTP 请求被中止）', async () => {
    const fetchMock = stubFetch(new Response('ok'))
    const controller = new AbortController()
    await createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('t') })(chatUrl, {
      body: '{}', signal: controller.signal,
    })

    expect(callOf(fetchMock)[1].signal).toBe(controller.signal)
  })

  it('上游状态码与安全响应头原样交回', async () => {
    const upstream = new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    })
    const fetchMock = stubFetch(upstream)
    const response = await createServerModelFetch({
      fetch: fetchMock, tokenEnvironment: tokenEnv('t'),
    })(chatUrl, { body: '{}' })

    expect(response.status).toBe(429)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.text()).toBe('{}')
  })

  it('响应体逐块交回，不攒也不重新包一层 Response', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
      },
    })
    const upstream = new Response(stream, { status: 200 })
    const fetchMock = stubFetch(upstream)
    const response = await createServerModelFetch({
      fetch: fetchMock, tokenEnvironment: tokenEnv('t'),
    })(chatUrl, { body: '{}' })

    // 身份相等 = 本层对响应方向一个字节都没碰（没有 Channel 那套事件→流的重组）。
    expect(response).toBe(upstream)
    const reader = response.body!.getReader()
    controller.enqueue(new TextEncoder().encode('data: one\n\n'))
    // 流没结束就已经能读到第一块——这正是「流式」而不是「攒完再给」。
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n')
    controller.close()
    expect((await reader.read()).done).toBe(true)
  })

  it('服务端的失败信封原样作为 Response 交回，不折成 reject', async () => {
    const failure = new Response(
      JSON.stringify({ error: 'model_request_failed', message: '未配置 DeepSeek API Key。' }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } },
    )
    const fetchMock = stubFetch(failure)
    const response = await createServerModelFetch({
      fetch: fetchMock, tokenEnvironment: tokenEnv('t'),
    })(chatUrl, { body: '{}' })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'model_request_failed', message: '未配置 DeepSeek API Key。',
    })
  })

  it.each([
    'https://untrusted.example/chat/completions',
    `${KIMI_GLOBAL_BASE_URL}/chat/completions`,
  ])('非白名单端点在发出 HTTP 请求之前就被拒：%s', async (url) => {
    const fetchMock = stubFetch(new Response('ok'))
    await expect(createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('t') })(
      url, { body: '{}' },
    )).rejects.toThrow('模型请求目标未获允许')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非 POST 的对话请求在发出 HTTP 请求之前就被拒', async () => {
    const fetchMock = stubFetch(new Response('ok'))
    await expect(createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('t') })(
      chatUrl, { method: 'GET', body: '{}' },
    )).rejects.toThrow('模型请求目标未获允许')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signal 已经 abort 时一次 HTTP 都不发', async () => {
    const fetchMock = stubFetch(new Response('ok'))
    const controller = new AbortController()
    controller.abort()

    await expect(createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('t') })(
      chatUrl, { body: '{}', signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Kimi 上传的 multipart 编码成 base64 进 JSON 信封', async () => {
    const fetchMock = stubFetch(new Response('{}'))
    const form = new FormData()
    form.append('purpose', 'file-extract')
    form.append('file', new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }), 'chart.png')

    await createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('t') })(
      `${KIMI_CN_BASE_URL}/files`, { method: 'POST', body: form },
    )

    expect(envelopeOf(fetchMock)).toEqual({
      target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
      body: {
        kind: 'multipart',
        parts: [
          { kind: 'text', name: 'purpose', value: 'file-extract' },
          {
            kind: 'file', name: 'file', fileName: 'chart.png',
            contentType: 'image/png', bytesBase64: 'AQID',
          },
        ],
      },
      requestId: expect.any(String),
    })
  })

  it('删除文件走无 body 的固定路由', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }))
    await createServerModelFetch({ fetch: fetchMock, tokenEnvironment: tokenEnv('t') })(
      `${KIMI_CN_BASE_URL}/files/file_123`, { method: 'DELETE' },
    )

    expect(envelopeOf(fetchMock)).toEqual({
      target: { provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/file_123' },
      body: { kind: 'none' },
      requestId: expect.any(String),
    })
  })
})

// 副本与正本的对拍（范式照抄 `apps/web/src/host/serverHealthContract.test.ts`）。
// ---------------------------------------------------------------------------
// `MODEL_ROUTE_PATH` 在仓库里有**两份**：正本 `apps/server/src/modelRoutePath.ts`（路由分派按它
// 判），副本就在本目录的 serverModelTransport.ts（请求按它发）。上面那条
// `expect(url).toBe('/api/model/request')` 只钉住了**副本这一侧**——服务端把路径挪走，本文件
// 照样全绿，而线上是每一条模型请求 404。症状（「模型全挂」）与病因（另一个 app 的另一个文件）
// 隔着两层目录，只靠注释盯不住。
//
// **读的是文本不是 import**：`apps/server` 与 `apps/web` 是两个 app，依赖方向里没有 app→app 这条
// 边（`check:boundaries` 会拦），而且真去 import 会把 `node:http` 与模型凭据那条链拖进浏览器
// 产物的模块图。所以按 serverHealthContract 的做法，把正本当源文件读进来做正则比对。
describe('与 apps/server/src/modelRoutePath.ts 的对拍', () => {
  // 不用 `new URL('字面量', import.meta.url)`：Vite 的 assetImportMetaUrl 会把它当资源引用静态
  // 改写，Vitest 下拿到的不是 file: URL，fileURLToPath 当场抛（S1 交回时记下的范式事实）。
  const serverRoutePathFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../server/src/modelRoutePath.ts',
  )
  const source = readFileSync(serverRoutePathFile, 'utf8')

  const readStringConst = (name: string): string => {
    const match = new RegExp(`export const ${name} = '([^']*)'`).exec(source)
    if (match === null) {
      throw new Error(
        `apps/server/src/modelRoutePath.ts 里找不到 export const ${name} —— 契约变形了，先去看那边`,
      )
    }
    return match[1]!
  }

  it('端点路径逐字一致', () => {
    expect(MODEL_ROUTE_PATH).toBe(readStringConst('MODEL_ROUTE_PATH'))
  })
})
