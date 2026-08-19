// 「AbortSignal 透传成 HTTP abort」这条判据的**真**证据：起一台真实 `node:http` 服务，用真
// `fetch` 打过去，然后在服务端观察 M2 用来触发取消的那个判据本身。
// ---------------------------------------------------------------------------
// 为什么非要真服务不可：M2 的取消把手挂在 `response.on('close')` 且 `writableEnded === false`
// 上（`apps/server/src/modelRouteStream.ts` 的 `watchClientConnection`）。而 M2 自己的测试
// **刻意没有用 fetch**——它的 testHarness 文件头写着「`AbortController` + fetch 与真正的
// `socket.destroy()` 在服务端看到的形态不一定一样」，于是那半边用 `request.destroy()` 测。
// 那句存疑正好是本卡要消掉的：浏览器这一侧真的一 abort 就断连、断出来的形态真的能被那条判据
// 认出来吗？只有把两侧接起来跑一次才知道。用假 fetch 断言 `init.signal === controller.signal`
// （另一个测试文件里那条）只证明「参数递对了」，证不了上游那次生成真的会停。
//
// 第三条用例是**负对照**：正常收尾时 `close` 同样会来，但 `writableEnded === true`。没有它，
// 前两条的 `closed === true` 说明不了任何事——`close` 本来就是每条响应都会触发的事件。

import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEEPSEEK_BASE_URL } from '@einfach-agent/ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerInvokeTokenEnvironment } from '../host/serverInvokeToken'
import { createServerModelFetch, type ServerModelFetch } from './serverModelTransport'

const chatUrl = `${DEEPSEEK_BASE_URL}/chat/completions`

interface Observed {
  path?: string
  authorization?: string
  /** 服务端从请求体里读到的 requestId——「响应头之前取消」唯一的把手就是它。 */
  requestId?: string
  closed: boolean
  /** M2 的分界判据：false = 对方先走了，true = 我们正常写完了。 */
  writableEnded?: boolean
}

interface Probe {
  readonly origin: string
  readonly observed: Observed
}

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // undici 的连接池会留着 keep-alive 连接，不掐掉 `close()` 会一直等（表现为用例超时）。
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  }
})

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(''))
  })
}

async function startProbeServer(respond: (response: ServerResponse) => void): Promise<Probe> {
  const observed: Observed = { closed: false }
  const server = createServer((request, response) => {
    observed.path = request.url
    observed.authorization = request.headers.authorization
    response.on('close', () => {
      observed.closed = true
      observed.writableEnded = response.writableEnded
    })
    void readBody(request).then((body) => {
      try {
        observed.requestId = (JSON.parse(body) as { requestId?: string }).requestId
      } catch {
        observed.requestId = undefined
      }
      respond(response)
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, observed }
}

/** 生产代码发的是相对路径（同源）；测试里补上这台临时服务的 origin。 */
function originFetch(origin: string): ServerModelFetch {
  return (input, init) => globalThis.fetch(new URL(input, origin), init)
}

function tokenEnv(token: string): ServerInvokeTokenEnvironment {
  return {
    location: { href: `http://127.0.0.1:4765/?token=${token}` },
    history: { state: null, replaceState: vi.fn() },
    sessionStorage: { getItem: () => null, setItem: vi.fn() },
  }
}

function modelFetch(probe: Probe): typeof fetch {
  return createServerModelFetch({
    fetch: originFetch(probe.origin),
    tokenEnvironment: tokenEnv('probe-token'),
  })
}

describe('serverModelTransport 的取消通路（真 HTTP）', () => {
  it('响应头还没交出来时中止：服务端看到 close 且 writableEnded=false，且手里已有 requestId', async () => {
    // 永不响应 = 「模型正在思考、还没吐第一个字」那几十秒，也是用户最可能放弃的时刻。
    const probe = await startProbeServer(() => undefined)
    const controller = new AbortController()
    const pending = modelFetch(probe)(chatUrl, { body: '{}', signal: controller.signal })

    await vi.waitFor(() => expect(probe.observed.requestId).toEqual(expect.any(String)))
    expect(probe.observed.path).toBe('/api/model/request')
    expect(probe.observed.authorization).toBe('Bearer probe-token')

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(probe.observed.closed).toBe(true))
    // 这两个断言合起来就是 M2 `watchClientConnection` 触发 `cancelInFlightModelRequest` 的全部前提。
    expect(probe.observed.writableEnded).toBe(false)
    expect(probe.observed.requestId).toEqual(expect.any(String))
  })

  it('流到一半中止：已经收到的字节仍在，服务端同样看到 close 且 writableEnded=false', async () => {
    const probe = await startProbeServer((response) => {
      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream')
      response.flushHeaders()
      response.write('data: one\n\n')
    })
    const controller = new AbortController()
    const response = await modelFetch(probe)(chatUrl, { body: '{}', signal: controller.signal })

    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n')

    controller.abort()

    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(probe.observed.closed).toBe(true))
    expect(probe.observed.writableEnded).toBe(false)
  })

  it('负对照：正常收尾时 close 照样会来，但 writableEnded=true（判据分得开这两者）', async () => {
    const probe = await startProbeServer((response) => {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      response.end('{"ok":true}')
    })
    const response = await modelFetch(probe)(chatUrl, { body: '{}' })

    expect(await response.text()).toBe('{"ok":true}')
    await vi.waitFor(() => expect(probe.observed.closed).toBe(true))
    expect(probe.observed.writableEnded).toBe(true)
  })
})
