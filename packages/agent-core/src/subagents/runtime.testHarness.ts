import { createTestDelegationRuntime } from './runtime.ports.testFixtures'
import type { DelegateAgentCallContext } from './types'

// 拆分说明：本文件是 runtime.test.ts 拆分后的公共夹具（只搬运、不改写），
// 供 runtime.<职责>.test.ts 系列文件共用。不包含任何用例。
// 被测对象由 core 自己的 `createDelegationRuntime` 加 `runtime.ports.testFixtures` 的假端口装出
//（见该文件头注）：这些用例测的是 core 的子 run 内核，不该反向依赖 `@einfach-agent/subagents`。

export function response(
  message: Record<string, unknown>,
  usage?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify({
    choices: [{ message }],
    ...(usage ? { usage } : {}),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 带 finish_reason 的响应：默认的 response() 不带该字段（等价于正常收尾），
// 用它来伪造 length / content_filter / insufficient_system_resource 三态。
export function finishedResponse(message: Record<string, unknown>, finishReason: string): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function toolCall(id: string, args: Record<string, unknown>): Response {
  return namedToolCall(id, 'delegate_agent', args)
}

export function namedToolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return response({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  })
}

// 直接投喂原始 arguments 字符串（绕开 JSON.stringify），用于伪造被截断/非对象的坏参数。
export function rawArgsToolCall(id: string, name: string, rawArgs: string): Response {
  return response({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: rawArgs } }],
  })
}

export interface TurnMessage {
  role: string
  content?: string
  tool_calls?: Array<{ id: string }>
  tool_call_id?: string
}

export function messagesOf(body: Record<string, unknown>): TurnMessage[] {
  return body.messages as TurnMessage[]
}

export function isContextDistillationRequest(body: Record<string, unknown>): boolean {
  return messagesOf(body).some((message) =>
    message.content?.includes('Create the durable context checkpoint now. Return only the checkpoint text.'),
  )
}

export function toolResultFor(body: Record<string, unknown>, callId: string): string {
  return messagesOf(body).find((message) => message.tool_call_id === callId)?.content ?? ''
}

// 契约：每个 tool_call 在下一轮消息里都必须有对应的 tool 结果，否则序列非法、整个 run 被接口拒。
export function orphanToolCallIds(body: Record<string, unknown>): string[] {
  const messages = messagesOf(body)
  const backfilled = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
  )
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id)
    .filter((id) => !backfilled.has(id))
}

export function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

export function childPath(body: Record<string, unknown>): string | undefined {
  const messages = body.messages as Array<{ role: string; content?: string }>
  return messages[0]?.content?.match(/树形子 agent ([^。]+)。/)?.[1]
}

export interface ArchiveEvent {
  type: string
  agentPath: string
  data?: Record<string, unknown>
}

// 归档事件日志（events.jsonl）是 append 模式写的，context() 的 writes map 会把它拼成整份正文。
export function eventsOf(writes: Map<string, string>): ArchiveEvent[] {
  const raw = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArchiveEvent)
}

export function eventsTyped(writes: Map<string, string>, type: string): ArchiveEvent[] {
  return eventsOf(writes).filter((event) => event.type === type)
}

export function context(writes: Map<string, string>): DelegateAgentCallContext {
  return {
    parentPath: 'root',
    parentTranscript: 'root transcript',
    progress() {},
    async writeTextFile(input) {
      writes.set(input.path, input.mode === 'append' ? `${writes.get(input.path) ?? ''}${input.content}` : input.content)
      return { ok: true }
    },
  }
}

export function runtime(
  fetchImpl: typeof fetch,
  signal = new AbortController().signal,
  modelUserId?: string,
) {
  return createTestDelegationRuntime({
    sessionId: 'session',
    runId: `run-${Math.random()}`,
    settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    hostHasLocalCapabilities: true,
    modelUserId,
    apiKey: 'test-key',
    signal,
    fetchImpl,
  })
}
