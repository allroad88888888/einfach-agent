// 测试脚手架（服务端那半边）：一台假上游 + 一台只挂了 model handler 的裸 server。
// 发请求那半边在 modelRouteClient.testHarness.ts。
// ---------------------------------------------------------------------------
// 【为什么是「真服务 + 改指」而不是「造一个 Response 返回」】（与 M1 的
// `upstreamServer.testHarness.ts` 同一套判据，那份在 packages/host-node 里，
// `tsconfig.app.json` 只把 `@web-agent/host-node` 映射到 barrel，深路径 import 解析不了，
// 所以这里另写一份最小的）：
//   · **本卡最要紧的用例是「客户端断开 → 上游真的被中断」**，而那只有真 socket 那一头看得见
//     （`response.on('close')` 且 `writableEnded === false`）。造出来的 Response 证明不了。
//   · 流式同理：造出来的 Response 是一次性给全的，证明不了「第一块到了就往下传」。真服务可以
//     先写一块、等测试确认收到、再写第二块——这才是「不是攒完再发」的判据。
//
// 【绝不打线上端点】白名单把 URL 钉死在三家供应商的 origin 上；`fetchImpl` 只换 origin，
// method / headers / body / signal / redirect 全部原样带过去。真实网络只有 127.0.0.1。
//
// 【必须清掉 `WEB_AGENT_CONFIG_DIR`】开发机上真设了这个变量时，不清就会去读运行测试那个人的
// 真实配置——里面有真的 API Key。

import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import { modelRequestRegistry } from '@web-agent/host-node'
import { createModelRouteHandler } from './modelRoute'
import { isModelRoutePath } from './modelRoutePath'
import { requestPathname } from './requestPathname'

/** 一把**已知**的 Key。「不外泄」的断言全拿它当探针。 */
export const TEST_API_KEY = 'sk-server-model-route-probe-0123456789'

/** host-node 的配置目录覆盖变量。它没在包的公开面上，这里按字面量写死并注明出处。 */
const CONFIG_DIRECTORY_ENV = 'WEB_AGENT_CONFIG_DIR'

export interface UpstreamRecord {
  readonly method: string
  readonly path: string
  readonly headers: NodeJS.Dict<string | string[]>
  readonly body: Buffer
  /** 连接是不是在响应写完之前就断了——「上游真的收到了中断」的判据。 */
  readonly aborted: Promise<boolean>
}

export type UpstreamHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  record: UpstreamRecord,
) => void

export interface FakeUpstream {
  readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>
  /** 本层看到的调用 URL（白名单拼出来的真实目标）。 */
  readonly calls: string[]
  /** 假上游那一头看到的请求。 */
  readonly received: UpstreamRecord[]
  close(): Promise<void>
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

export async function startFakeUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const calls: string[] = []
  const received: UpstreamRecord[] = []
  const server: Server = createServer((request, response) => {
    let settleAborted: (aborted: boolean) => void = () => undefined
    const aborted = new Promise<boolean>((resolve) => {
      settleAborted = resolve
    })
    response.on('close', () => settleAborted(!response.writableEnded))
    // 断连用例里对方会在我们还在写的时候走掉，socket 会抛 ECONNRESET/EPIPE。不接住的话它是一次
    // 未捕获异常，整个测试进程当场挂掉——而挂掉的原因看起来与被测行为无关。
    request.on('error', () => undefined)
    response.on('error', () => undefined)
    void readBody(request).then((body) => {
      const record: UpstreamRecord = {
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
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  return {
    calls,
    received,
    fetchImpl: (url, init) => {
      calls.push(url)
      const target = new URL(url)
      return globalThis.fetch(`${origin}${target.pathname}${target.search}`, init)
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export interface TestServerOptions {
  readonly maxBodyBytes?: number
  readonly timeoutMs?: number
}

export interface ModelRouteTestContext {
  /** 本用例的临时主目录（`<home>/.webAgent/config.json` 就是那份配置）。 */
  readonly home: string
  /** 覆写 `modelCredentials` 段。默认已写好 deepseek 与 kimi 两把。 */
  writeCredentials(credentials: Record<string, string>): Promise<void>
  /** 起一台假上游，用例结束时自动关。 */
  upstream(handler: UpstreamHandler): Promise<FakeUpstream>
  /** 起一台只挂了 model handler 的裸 server，返回端口；用例结束时自动关。 */
  serve(fake: FakeUpstream, options?: TestServerOptions): Promise<number>
}

/**
 * 起一台裸 `http.Server`，只挂 `createModelRouteHandler`。
 *
 * **不复用 `testServer.testHarness.ts`**：那边起的是完整 `createWebAgentServer()`，而本卡的路由
 * 还没接进 `requestRouter.ts`（C5 正在并行改 `main*`，接线由主会话统一做）。外层那个 try/catch
 * 是 `requestRouter.ts` 现有兜底的最小等价物——好让「未预期异常收成 500 / 已发头就断连」这条
 * 行为在裸 server 上也成立，而不是把测试进程炸掉。
 */
async function startModelRouteServer(
  fake: FakeUpstream,
  home: string,
  options: TestServerOptions,
): Promise<{ port: number, close: () => Promise<void> }> {
  const handler = createModelRouteHandler({
    forward: { options: { homeDir: home }, fetchImpl: fake.fetchImpl, timeoutMs: options.timeoutMs },
    maxBodyBytes: options.maxBodyBytes,
  })
  const server = createServer((request, response) => {
    void (async () => {
      if (!isModelRoutePath(requestPathname(request.url))) {
        response.statusCode = 404
        response.end()
        return
      }
      try {
        await handler(request, response)
      } catch (error) {
        if (response.headersSent) response.destroy()
        else {
          response.statusCode = 500
          response.end(String(error))
        }
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

/** 在测试文件顶层调用一次；它自己登记 beforeEach / afterEach。 */
export function useModelRouteTestContext(): ModelRouteTestContext {
  const state = { home: '' }
  const upstreams: FakeUpstream[] = []
  const servers: Array<{ close: () => Promise<void> }> = []
  let savedOverride: string | undefined

  async function writeCredentials(credentials: Record<string, string>): Promise<void> {
    await mkdir(join(state.home, '.webAgent'), { recursive: true })
    await writeFile(
      join(state.home, '.webAgent', 'config.json'),
      JSON.stringify({ version: 1, modelCredentials: credentials }),
    )
  }

  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'web-agent-model-route-'))
    savedOverride = process.env[CONFIG_DIRECTORY_ENV]
    delete process.env[CONFIG_DIRECTORY_ENV]
    await writeCredentials({ 'deepseek:default': TEST_API_KEY, 'kimi:cn': TEST_API_KEY })
  })

  afterEach(async () => {
    if (savedOverride === undefined) delete process.env[CONFIG_DIRECTORY_ENV]
    else process.env[CONFIG_DIRECTORY_ENV] = savedOverride
    await Promise.all(servers.splice(0).map((server) => server.close()))
    await Promise.all(upstreams.splice(0).map((fake) => fake.close()))
    await rm(state.home, { recursive: true, force: true })
  })

  return {
    get home() {
      return state.home
    },
    writeCredentials,
    async upstream(handler) {
      const fake = await startFakeUpstream(handler)
      upstreams.push(fake)
      return fake
    },
    async serve(fake, options = {}) {
      const server = await startModelRouteServer(fake, state.home, options)
      servers.push(server)
      return server.port
    },
  }
}

/**
 * 轮询等一个条件成立（最多 2 秒），不成立就当场断言失败。
 *
 * 断连路径上的收尾是在事件回调里发起的（`close` → `release()`），读一次断言必然是竞态。
 */
export async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  expect(predicate(), label).toBe(true)
}

/**
 * 等在飞请求表回到空。
 *
 * **泄漏的唯一可观测形态就是它不回到 0**：拿到响应头却不消费时 generator 的 finally 不会跑，
 * 那条账会永远留在表里（内存泄漏 + 那次请求再也取消不掉）。
 */
export async function waitForNoActiveModelRequests(): Promise<void> {
  await waitUntil(() => modelRequestRegistry.activeCount === 0, '在飞请求表没有回到空')
}

/** 聊天端点的规范信封。每个用例给自己的 `requestId`——在飞请求表拒绝重复登记。 */
export function chatEnvelope(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    target: { provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions' },
    body: { kind: 'json', json: '{"model":"deepseek-chat"}' },
    requestId,
    ...overrides,
  }
}

/**
 * 删除上传文件的信封。响应上限是 1 MiB（聊天端点是 32 MiB，在测试里跑不动），
 * 「流中累计超限」那条用例靠它才构造得出来。
 */
export function deleteEnvelope(requestId: string) {
  return {
    target: { provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/abc' },
    body: { kind: 'none' },
    requestId,
  }
}
