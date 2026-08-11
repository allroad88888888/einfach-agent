// E1 判据：run 开始时固定工具集 epoch —— run 期间 registry 怎么变，都不改变本 run 已组装的清单。
// ---------------------------------------------------------------------------
// 复现的是真实病灶：MCP 的 tools/list_changed 与断线会【立刻】改进程级 toolRegistry。
// 这里在两轮模型请求之间注销一个工具、注册另一个工具，断言：
//   · 注入的 manifest 文本不变（被注销的还在，新注册的不出现）；
//   · 本轮 tools 数组不缩水，被注销工具的 schema 仍是 run 开始时那份；
//   · request_tool_schema 的发现分页与注入的 manifest 同源，不会多出新工具；
//   · 下一个 run 才看到 registry 的新状态（固定是 per-run，不是永久冻结）。

import { describe, expect, it } from 'vitest'
import type { ModelFunctionTool, ModelItem } from '@web-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCoreInstance } from './core/coreInstance'
import type { Tool } from '../tools/types'
import { runSession } from './modelRun'

const SESSION_ID = 'tool-epoch-run'

interface RequestBody {
  messages: ModelItem[]
  tools?: ModelFunctionTool[]
}

function dynamicTool(name: string, guide: string): Tool {
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

function toolCallsResponse(calls: Array<{ name: string; args: unknown; id: string }>): Response {
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

function textResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function manifestTextOf(body: RequestBody | undefined): string {
  const item = body?.messages.find(
    (message) => message.role === 'system' && message.content.startsWith('可用工具摘要'),
  )
  if (!item || item.role !== 'system') throw new Error('请求里没有注入工具摘要清单')
  return item.content
}

function exposedToolNames(body: RequestBody | undefined): string[] {
  return (body?.tools ?? []).map((tool) => tool.function.name).sort()
}

function toolResultPayload(core: ReturnType<typeof createCoreInstance>, callId: string): unknown {
  const item = core.getSessionStore(SESSION_ID).store.getter(itemsAtom).find(
    ({ item: entry }) => entry.role === 'tool' && entry.tool_call_id === callId,
  )?.item
  if (!item || item.role !== 'tool') throw new Error(`缺少 ${callId} 的工具结果`)
  return JSON.parse(item.content)
}

function seedCore() {
  const core = createCoreInstance()
  core.tools.register(dynamicTool('alpha_tool', 'alpha 的完整指南：run 开始时的这一版'))
  core.tools.register(dynamicTool('beta_tool', 'beta 的完整指南'))
  core.rootStore.setter(sessionsAtom, {
    [SESSION_ID]: {
      id: SESSION_ID,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
  return core
}

describe('run 工具集 epoch（E1）', () => {
  it('run 期间注销/注册工具，不改变本 run 已组装给模型的清单', async () => {
    const core = seedCore()
    const bodies: RequestBody[] = []

    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as RequestBody)
      if (bodies.length === 1) {
        // 模型先按 lazy-tool 协议加载 alpha_tool 的 schema。
        return toolCallsResponse([{
          id: 'load-alpha',
          name: 'request_tool_schema',
          args: { toolName: 'alpha_tool', reason: '读取参数' },
        }])
      }
      if (bodies.length === 2) {
        // 第 2 轮请求已经带着 alpha_tool 的 schema 发出；此刻模拟 MCP tools_changed：
        // 注销 alpha_tool、注册 gamma_tool。第 3 轮请求必须对此完全无感。
        core.tools.unregister('alpha_tool')
        core.tools.register(dynamicTool('gamma_tool', 'run 中途才出现的工具'))
        return toolCallsResponse([{
          id: 'discover',
          name: 'request_tool_schema',
          args: { reason: '看看还有什么工具' },
        }])
      }
      return textResponse('结束')
    }

    await runSession(SESSION_ID, '开始', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    expect(bodies).toHaveLength(3)
    // registry 真的变了——被固定的只是本 run 的视图。
    expect(core.tools.has('alpha_tool')).toBe(false)
    expect(core.tools.has('gamma_tool')).toBe(true)

    // ① 注入的 manifest 文本三轮逐字相同：既没丢 alpha_tool，也没混进 gamma_tool。
    const manifests = bodies.map(manifestTextOf)
    expect(new Set(manifests).size).toBe(1)
    expect(manifests[2]).toContain('alpha_tool')
    expect(manifests[2]).toContain('beta_tool')
    expect(manifests[2]).not.toContain('gamma_tool')

    // ② 已加载的 alpha_tool 不因注销而从 tools 里消失，schema 仍是 run 开始时那份。
    expect(exposedToolNames(bodies[1])).toEqual(['alpha_tool', 'request_tool_schema'])
    expect(exposedToolNames(bodies[2])).toEqual(['alpha_tool', 'request_tool_schema'])
    const exposedAlpha = bodies[2].tools?.find((tool) => tool.function.name === 'alpha_tool')
    expect(exposedAlpha?.function.description).toContain('run 开始时的这一版')

    // ③ 发现分页与注入的 manifest 同源。
    const discovery = toolResultPayload(core, 'discover') as { items: Array<{ name: string }> }
    expect(discovery.items.map((item) => item.name).sort()).toEqual(['alpha_tool', 'beta_tool'])

    expect(core.getSessionStore(SESSION_ID).store.getter(runAtom)?.status).toBe('done')
  })

  it('固定只在本 run 内生效：下一个 run 重新冻结出 registry 的新状态', async () => {
    const core = seedCore()
    const bodies: RequestBody[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as RequestBody)
      return textResponse('好的')
    }

    await runSession(SESSION_ID, '第一轮', {
      signal: new AbortController().signal, apiKey: 'k', fetchImpl, core,
    })
    core.tools.unregister('alpha_tool')
    core.tools.register(dynamicTool('gamma_tool', 'run 之间出现的工具'))
    await runSession(SESSION_ID, '第二轮', {
      signal: new AbortController().signal, apiKey: 'k', fetchImpl, core,
    })

    expect(manifestTextOf(bodies[0])).toContain('alpha_tool')
    expect(manifestTextOf(bodies[0])).not.toContain('gamma_tool')
    expect(manifestTextOf(bodies[1])).not.toContain('alpha_tool')
    expect(manifestTextOf(bodies[1])).toContain('gamma_tool')
  })
})
