// modelRun 测试套件的公共夹具与 helper —— 不含任何 it/describe。
// 拆分自 modelRun.test.ts（T1），供 modelRun.*.test.ts 系列文件复用。

import { rootStore, sessionsAtom } from '../state/rootStore'
import type { ModelSettings } from '../state/core.type'
import type { ModelUsage } from '@web-agent/ai'
import { resetPersistence } from './persistenceBridge'
import { resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import { configureDefaultDelegation, defaultCore } from './core/coreInstance'

// 每个 modelRun.*.test.ts 在自己的 afterEach 里调用它，收敛跨用例复位逻辑。
// 注：vi.hoisted 的 tauriControl / disposeControl 属于各自文件的 vi.mock 私有状态，
// 不能塞进共享模块（会破坏 vi.mock 的按文件 hoist 语义），因此不在这里处理。
export function resetModelRunTestState(): void {
  resetObservability()
  resetPersistence()
  defaultCore.planRuntime = undefined
  configureDefaultDelegation(null)
}

// 在 rootStore 登记一个会话（ghost guard 的权威事实）。
export function seedSession(id: string, settings: ModelSettings): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings, createdAt: Date.now(), updatedAt: Date.now() },
  }))
}

// 非流式响应：postChatCompletion 走 res.json()。
export function jsonResponse(
  content: string,
  usage?: ModelUsage,
): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// 一次「tool_calls」轮响应：content:null + tool_calls（id 可选——省略时校验 runtime 自造 id 回填）。
export function toolCallsResponse(calls: Array<{ name: string; args: unknown; id?: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c) => ({
              ...(c.id ? { id: c.id } : {}),
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// 指定 finish_reason 的普通（无 tool_calls）响应 —— 用于 length/content_filter/容量不足三态。
export function finishReasonResponse(finishReason: string, content: string | null): Response {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// tool_calls 响应，但 arguments 由调用方给「原始字符串」—— 用于构造被截断/非法的参数 JSON。
export function rawToolCallsResponse(
  finishReason: string,
  calls: Array<{ name: string; args: string; id: string }>,
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.args },
            })),
          },
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// 按调用次序返回不同 Response（越界后固定返回最后一个 maker）；count() = 已发起请求次数。
export function seqFetch(makers: Array<() => Response>): { fetchImpl: typeof fetch; count: () => number } {
  let i = 0
  const fetchImpl: typeof fetch = async () => {
    const maker = makers[Math.min(i, makers.length - 1)]
    i += 1
    return maker()
  }
  return { fetchImpl, count: () => i }
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function captureTrace(): { spans: TraceSpan[]; events: TraceEvent[]; driver: TraceDriver } {
  const spans: TraceSpan[] = []
  const events: TraceEvent[] = []
  return {
    spans,
    events,
    driver: {
      async writeSpan(span) {
        spans.push(clone(span))
      },
      async writeEvent(event) {
        events.push(clone(event))
      },
    },
  }
}

export function sseBlock(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(sseBlock(chunk)))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

export async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}
