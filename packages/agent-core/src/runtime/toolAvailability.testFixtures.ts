// 「run 期间工具集怎么变」这一族测试（E1/E2）共用的脚手架。
//
// 单一职责：把「造一个带动态工具的 core、用假 fetch 跑一个 run、再从请求体和消息历史里
// 取回可断言的事实」这套样板集中在一处。这里不含任何判据，判据都在各自的 *.test.ts 里。

import type { ModelFunctionTool, ModelItem } from '@einfach-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom } from '../state/sessionAtoms'
import { createCoreInstance } from './core/coreInstance'
import type { Tool } from '../tools/types'
import { runSession } from './modelRun'

export const SESSION_ID = 'tool-availability-run'

export type TestCore = ReturnType<typeof createCoreInstance>

export interface RequestBody {
  messages: ModelItem[]
  tools?: ModelFunctionTool[]
}

/** 一个行为可预测的动态工具：执行成功并回报自己的名字。 */
export function dynamicTool(name: string, guide: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 的一句话摘要`, content: guide },
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    },
    execute: () => ({ ok: true as const, data: { tool: name } }),
  }
}

export function toolCallsResponse(calls: Array<{ name: string; args: unknown; id: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

export function textResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** 注入到 system 前缀里的工具摘要清单原文。 */
export function manifestTextOf(body: RequestBody | undefined): string {
  const item = body?.messages.find(
    (message) => message.role === 'system' && message.content.startsWith('可用工具摘要'),
  )
  if (!item || item.role !== 'system') throw new Error('请求里没有注入工具摘要清单')
  return item.content
}

/** 本轮请求顶层 tools 里的工具名（已排序）。 */
export function exposedToolNames(body: RequestBody | undefined): string[] {
  return (body?.tools ?? []).map((tool) => tool.function.name).sort()
}

export function toolResultPayload(core: TestCore, callId: string): Record<string, unknown> {
  const item = core.getSessionStore(SESSION_ID).store.getter(itemsAtom).find(
    ({ item: entry }) => entry.role === 'tool' && entry.tool_call_id === callId,
  )?.item
  if (!item || item.role !== 'tool') throw new Error(`缺少 ${callId} 的工具结果`)
  return JSON.parse(item.content) as Record<string, unknown>
}

/** 一个注册了 alpha_tool / beta_tool 的独立 core，外加一个可用的会话。 */
export function seedCore(): TestCore {
  const core = createCoreInstance()
  core.tools.register(dynamicTool('alpha_tool', 'alpha 的完整指南：run 开始时的这一版'))
  core.tools.register(dynamicTool('beta_tool', 'beta 的完整指南'))
  core.rootStore.setter(sessionsAtom, {
    [SESSION_ID]: {
      id: SESSION_ID,
      title: 't',
      settings: { vendor: 'test-vendor', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
  return core
}

/**
 * 跑一个 run，逐轮由 `respond` 决定模型回什么，并收集每一轮真正发出去的请求体。
 *
 * `respond` 的入参是本轮的序号（从 1 开始），它在【请求已经组装完毕之后】被调用——
 * 因此在它体内改 registry，模拟的正是「MCP 在两轮之间掉线/连上」。
 */
export async function runWithResponses(
  core: TestCore,
  respond: (turn: number) => Response,
): Promise<RequestBody[]> {
  const bodies: RequestBody[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as RequestBody)
    return respond(bodies.length)
  }
  await runSession(SESSION_ID, '开始', {
    signal: new AbortController().signal,
    apiKey: 'k',
    fetchImpl,
    core,
  })
  return bodies
}
