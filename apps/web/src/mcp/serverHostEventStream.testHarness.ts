// 事件流用例的假传输：一条能被逐块喂数据的 `fetch` + 响应体。
// ---------------------------------------------------------------------------
// 单独成文件的理由与 `apps/server/src/eventsRoute.testHarness.ts` 相同：脚手架回答的是
// 「怎么伪造一条 SSE 连接」，用例回答的是「连上之后该发生什么」，两件事。
// 名字用 `.testHarness.ts` 后缀是仓库既定口径（`scripts/check-boundaries.js` 的
// `testFilePattern` 认这个后缀，不把它当生产代码扫）。

import type { ServerInvokeTokenEnvironment } from '../host/serverInvokeToken'
import type {
  ServerHostEventStreamFetch,
  ServerHostEventStreamReader,
} from './serverHostEventStream'

export const streamEncoder = new TextEncoder()

type ReadResult = { readonly done: boolean, readonly value?: Uint8Array }

export interface FakeSseConnection {
  push(text: string): void
  pushBytes(bytes: Uint8Array): void
  /** 服务端正常结束这条响应。 */
  end(): void
  /** 读取过程中抛错（socket 断了）。 */
  fail(error: unknown): void
  readonly reader: ServerHostEventStreamReader
  cancelled(): boolean
}

/**
 * 一条假响应体。`read()` 在没有数据时**挂着**——真实的 SSE 就是这样，
 * 而这正好让「读取循环停在哪里」这件事在用例里可控。
 */
export function createFakeSseConnection(): FakeSseConnection {
  const queue: Array<ReadResult | { readonly error: unknown }> = []
  let resolveRead: ((value: ReadResult) => void) | undefined
  let rejectRead: ((error: unknown) => void) | undefined
  let cancelled = false

  function deliver(): void {
    if (queue.length === 0 || resolveRead === undefined || rejectRead === undefined) return
    const next = queue.shift()!
    const resolve = resolveRead
    const reject = rejectRead
    resolveRead = undefined
    rejectRead = undefined
    if ('error' in next) reject(next.error)
    else resolve(next)
  }

  return {
    push(text) { queue.push({ done: false, value: streamEncoder.encode(text) }); deliver() },
    pushBytes(bytes) { queue.push({ done: false, value: bytes }); deliver() },
    end() { queue.push({ done: true }); deliver() },
    fail(error) { queue.push({ error }); deliver() },
    cancelled: () => cancelled,
    reader: {
      read: () => new Promise<ReadResult>((resolve, reject) => {
        resolveRead = resolve
        rejectRead = reject
        deliver()
      }),
      cancel: () => { cancelled = true },
    },
  }
}

/** 一次 fetch 该怎么表现：给一条流 / 回一个状态码 / 连不上。 */
export type FetchStep = 'stream' | 'network-error' | number

export interface SseFetchHarness {
  readonly fetchImpl: ServerHostEventStreamFetch
  readonly calls: Array<{ headers: Record<string, string>, signal: AbortSignal }>
  readonly connections: FakeSseConnection[]
  /** 排下来几次 fetch 的剧本；用完之后一律给正常的流。 */
  plan(steps: readonly FetchStep[]): void
}

export function createSseFetchHarness(): SseFetchHarness {
  const calls: Array<{ headers: Record<string, string>, signal: AbortSignal }> = []
  const connections: FakeSseConnection[] = []
  let steps: FetchStep[] = []

  return {
    calls,
    connections,
    plan(next) { steps = [...next] },
    fetchImpl: async (_input, init) => {
      calls.push({ headers: init.headers, signal: init.signal })
      const step = steps.shift() ?? 'stream'
      if (step === 'network-error') throw new TypeError('fetch failed')
      if (typeof step === 'number') return { ok: false, status: step, body: null }
      const connection = createFakeSseConnection()
      connections.push(connection)
      return { ok: true, status: 200, body: { getReader: () => connection.reader } }
    },
  }
}

/** 一个平凡的 token 环境：不碰 `window`，也不做地址栏清理。 */
export function fakeTokenEnvironment(token: string | undefined): ServerInvokeTokenEnvironment {
  const store = new Map<string, string>()
  if (token !== undefined) store.set('web-agent:server-invoke-token', token)
  return {
    location: { href: 'http://127.0.0.1:4321/' },
    history: { state: null, replaceState: () => {} },
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => { store.set(key, value) },
    },
  }
}

/** 编一帧事件，与 `apps/server/src/eventsRouteFrame.ts` 的输出同形。 */
export function sseFrame(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}
