// 测试用的「假上游」：一台本机 HTTP 服务 + 一个把白名单 URL 改指过来的 fetch
// ---------------------------------------------------------------------------
// 本域的测试**绝不允许**打到任何供应商的线上端点：白名单把 URL 钉死在三家的 origin 上，不注入
// fetch 就意味着一跑测试就真的发请求、真的花用户的额度、还真的需要一个 Key。
//
// 为什么是「真服务 + 改指」而不是「返回一个造好的 Response」：
//   · **取消要证明的是上游真的被中断了**，不是「我们记了一个标记」。只有真 socket 那一头才看得见
//     请求被中止（`response.on('close')` 且 `writableEnded === false`）。
//   · 流式透传同理：造出来的 Response 是一次性给全的，证明不了「第一块到了就往下传」。真服务
//     可以先写一块、等测试确认收到、再写第二块。
//   · vitest 跑在 jsdom 环境里，`Response` / `ReadableStream` 到底是 jsdom 的还是 undici 的并不
//     稳定；走真 fetch 就不依赖这件事。
//
// 改指只换 origin，**method / headers / body / signal / redirect 全部原样带过去**——那些正是
// 测试要断言的东西。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ModelFetch } from './upstreamRequest'

export interface UpstreamCall {
  readonly url: string
  readonly init: RequestInit
}

export interface UpstreamRequestRecord {
  readonly method: string
  readonly path: string
  readonly headers: NodeJS.Dict<string | string[]>
  readonly body: Buffer
  /** 连接是不是在响应写完之前就断了——这就是「上游真的收到了中断」的判据。 */
  readonly aborted: Promise<boolean>
}

export interface FakeUpstream {
  /** 交给 `forwardProviderRequest` 的 fetch。 */
  readonly fetchImpl: ModelFetch
  /** 本层看到的调用（白名单拼出来的真实 URL 与 init）。 */
  readonly calls: UpstreamCall[]
  /** 假上游那一头看到的请求。 */
  readonly received: UpstreamRequestRecord[]
  close(): Promise<void>
}

export type UpstreamHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  record: UpstreamRequestRecord,
) => void

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export async function startFakeUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const calls: UpstreamCall[] = []
  const received: UpstreamRequestRecord[] = []
  const server: Server = createServer((request, response) => {
    let settleAborted: (aborted: boolean) => void = () => undefined
    const aborted = new Promise<boolean>((resolve) => {
      settleAborted = resolve
    })
    // `close` 在响应结束或连接断掉时都会来；`writableEnded` 区分这两者。
    response.on('close', () => settleAborted(!response.writableEnded))
    // 取消用例里客户端会在服务端还在写的时候断连，那会让 socket 抛 ECONNRESET/EPIPE。
    // 不接住的话它变成一次未捕获异常，整个测试进程当场挂掉——而挂掉的原因看起来与被测行为无关。
    request.on('error', () => undefined)
    response.on('error', () => undefined)
    void readBody(request).then((body) => {
      const record: UpstreamRequestRecord = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
        aborted,
      }
      received.push(record)
      handler(request, response, record)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('假上游没有监听 TCP 端口')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    calls,
    received,
    fetchImpl: (url, init) => {
      calls.push({ url, init })
      const target = new URL(url)
      return globalThis.fetch(`${origin}${target.pathname}${target.search}`, init)
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 收完一条流并拼成一个 Buffer。 */
export async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
