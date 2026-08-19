import { describe, expect, it, vi } from 'vitest'
import type { ModelItem } from '@einfach-agent/ai'
import { sessionsAtom } from '../state/rootStore'
import { subagentContinuationsAtom } from '../state/subagentContinuationAtoms'
import { createCoreInstance } from '../runtime/core/coreInstance'
import type { Tool } from '../tools/types'
import { createTestDelegationCapability, createTestDelegationRuntime } from './runtime.ports.testFixtures'
import type { DelegateAgentCallContext } from './types'

type TraceEntry = {
  agentPath: string
  item: Pick<ModelItem, 'role' | 'content'> & { tool_call_id?: string }
}

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function timingTool(name: string, callTiming: 'subagentStart' | 'subagentEnd', runtime: Tool['runtime'] = 'internal'): Tool {
  return {
    name,
    runtime,
    callTiming,
    skill: { description: name, content: `${name} guide` },
    inputSchema: { type: 'object', additionalProperties: false },
    execute: () => ({ ok: true }),
  }
}

function plainTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: `${name} guide` },
    inputSchema: { type: 'object', additionalProperties: false },
    execute: () => ({ ok: true }),
  }
}

function isChildRequest(body: Record<string, unknown>): boolean {
  const first = (body.messages as Array<{ content?: unknown }>)[0]
  return typeof first?.content === 'string' && first.content.includes('树形子 agent')
}

function body(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function context(runChildTool: NonNullable<DelegateAgentCallContext['runChildTool']>): DelegateAgentCallContext {
  return { parentPath: 'root', parentTranscript: 'root', progress() {}, runChildTool, async writeTextFile() { return { ok: true } } }
}

function childRuntime(input: {
  runId: string
  tools: Tool[]
  hostHasLocalCapabilities?: boolean
  fetchImpl: typeof fetch
  trace: TraceEntry[]
  signal?: AbortSignal
}) {
  const core = createCoreInstance({ delegation: createTestDelegationCapability, registerTools: (registry) => {
    registry.register(plainTool('delegate_agent'))
    input.tools.forEach((tool) => registry.register(tool))
  } })
  core.rootStore.setter(sessionsAtom, {
    session: { id: 'session', title: 'child timing', settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' }, createdAt: 0, updatedAt: 0 },
  })
  const runtime = createTestDelegationRuntime({
    sessionId: 'session', runId: input.runId, settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    apiKey: 'test', signal: input.signal ?? new AbortController().signal, fetchImpl: input.fetchImpl,
    core, registry: core.tools, scheduler: core.delegation!.scheduler, hostHasLocalCapabilities: input.hostHasLocalCapabilities,
    onTraceItem: ({ agentPath, item }) => input.trace.push({ agentPath, item }),
  })
  return { core, runtime }
}

describe('child Agent 到点工具', () => {
  it('在首个 child 请求前按注册顺序运行，失败降级并仅归档 child trace', async () => {
    const order: string[] = []
    const trace: TraceEntry[] = []
    const requests: Record<string, unknown>[] = []
    const { runtime } = childRuntime({
      runId: 'run-start',
      tools: [
        timingTool('read_file', 'subagentStart'),
        timingTool('list_files', 'subagentStart'),
        timingTool('search_files', 'subagentStart'),
        timingTool('run_verification_command', 'subagentStart'),
        timingTool('rg_search', 'subagentEnd'),
      ],
      hostHasLocalCapabilities: true,
      trace,
      fetchImpl: async (_url, init) => {
        const request = body(init)
        if (isChildRequest(request)) {
          order.push('model')
          requests.push(request)
          return response('done')
        }
        return response('# distilled skill')
      },
    })
    const runChildTool = vi.fn(async (name: string) => {
      order.push(name)
      if (name === 'list_files') throw new Error('timed failure')
      return { ok: true as const, data: { name } }
    })

    const result = await runtime.delegateAgents({
      toolProfile: 'workspace_read', children: [{ objective: 'inspect one item' }],
    }, context(runChildTool))

    expect(result.children[0]?.status).toBe('done')
    expect(order).toEqual(['read_file', 'list_files', 'search_files', 'model', 'rg_search'])
    expect(trace.filter(({ item }) => item.role === 'tool').map(({ item }) => item.tool_call_id)).toEqual([
      'timed:subagentStart:run-start:root-01:read_file',
      'timed:subagentStart:run-start:root-01:list_files',
      'timed:subagentStart:run-start:root-01:search_files',
      'timed:subagentEnd:run-start:root-01:rg_search',
    ])
    expect(trace.find(({ item }) => item.tool_call_id?.endsWith(':list_files'))?.item.content).toContain('timed failure')
    expect(requests.flatMap((request) => request.messages as Array<{ role: string }>).filter((item) => item.role === 'tool')).toEqual([])
    await runtime.dispose?.()
  })

  it('子模型异常时仍在 finally 分派 subagentEnd', async () => {
    const trace: TraceEntry[] = []
    const calls: string[] = []
    const { runtime } = childRuntime({
      runId: 'run-failed', tools: [timingTool('read_file', 'subagentStart'), timingTool('rg_search', 'subagentEnd')],
      hostHasLocalCapabilities: true, trace,
      fetchImpl: async (_url, init) => isChildRequest(body(init))
        ? new Response('bad request', { status: 400 })
        : response('# distilled skill'),
    })

    const result = await runtime.delegateAgents({
      toolProfile: 'workspace_read', children: [{ objective: 'fail the child request' }],
    }, context(async (name) => {
      calls.push(name)
      return { ok: true, data: { name } }
    }))

    expect(result.children[0]?.status).toBe('failed')
    expect(calls).toEqual(['read_file', 'rg_search'])
    expect(trace.some(({ item }) => item.tool_call_id === 'timed:subagentEnd:run-failed:root-01:rg_search')).toBe(true)
    await runtime.dispose?.()
  })

  it('Web 对 server 到点工具失败关闭，Tauri 在允许 profile 内经 child bridge 执行', async () => {
    const run = async (hostHasLocalCapabilities: boolean) => {
      const trace: TraceEntry[] = []
      const bridge = vi.fn(async () => ({ ok: true as const }))
      const { runtime } = childRuntime({
        runId: `run-server-${hostHasLocalCapabilities}`, tools: [timingTool('run_verification_command', 'subagentStart', 'server')],
        hostHasLocalCapabilities, trace, fetchImpl: async (_url, init) => isChildRequest(body(init)) ? response('done') : response('# distilled skill'),
      })
      await runtime.delegateAgents({ toolProfile: 'workspace_verify', children: [{ objective: 'verify' }] }, context(bridge))
      await runtime.dispose?.()
      return { bridge, trace }
    }

    const web = await run(false)
    const tauri = await run(true)
    expect(web.bridge).not.toHaveBeenCalled()
    expect(web.trace.some(({ item }) => item.role === 'tool')).toBe(false)
    expect(tauri.bridge).toHaveBeenCalledWith('run_verification_command', {}, expect.any(Number))
    expect(tauri.trace.some(({ item }) => item.tool_call_id?.includes(':run_verification_command'))).toBe(true)
  })

  it('中止的 child 仍归档 subagentEnd，但不会在已中止后启动工具', async () => {
    const abort = new AbortController()
    const trace: TraceEntry[] = []
    const bridge = vi.fn(async () => ({ ok: true as const }))
    const { runtime } = childRuntime({
      runId: 'run-cancelled', tools: [timingTool('read_file', 'subagentStart'), timingTool('rg_search', 'subagentEnd')],
      hostHasLocalCapabilities: true, trace, signal: abort.signal,
      fetchImpl: async (_url, init) => {
        if (!isChildRequest(body(init))) return response('# distilled skill')
        abort.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    })

    const result = await runtime.delegateAgents({
      toolProfile: 'workspace_read', children: [{ objective: 'cancel this child' }],
    }, context(bridge))

    expect(result.children[0]?.status).toBe('cancelled')
    expect(bridge).toHaveBeenCalledTimes(1)
    const end = trace.find(({ item }) => item.tool_call_id === 'timed:subagentEnd:run-cancelled:root-01:rg_search')
    expect(end?.item.content).toContain('已中止')
    await runtime.dispose?.()
  })

  it('危险的 child 到点工具只归档拒绝结果，不触发 child bridge', async () => {
    const trace: TraceEntry[] = []
    const bridge = vi.fn(async () => ({ ok: true as const }))
    const { runtime } = childRuntime({
      runId: 'run-risk', tools: [timingTool('shell_linux', 'subagentStart')], hostHasLocalCapabilities: true, trace,
      fetchImpl: async (_url, init) => isChildRequest(body(init)) ? response('done') : response('# distilled skill'),
    })

    const riskContext = context(bridge)
    riskContext.delegationCallId = 'risk-call'
    riskContext.dangerousToolCapability = {
      sessionId: 'session', runId: 'run-risk', delegationCallId: 'risk-call', parentPath: 'root', toolNames: ['shell_linux'],
    }
    const result = await runtime.delegateAgents({
      toolProfile: 'workspace_read', confirmedTools: ['shell_linux'], children: [{ objective: 'do not run a shell' }],
    }, riskContext)

    expect(result.children[0]?.status).toBe('done')
    expect(bridge).not.toHaveBeenCalled()
    expect(trace.find(({ item }) => item.tool_call_id?.endsWith(':shell_linux'))?.item.content).toContain('风险等级 dangerous')
    await runtime.dispose?.()
  })

  const legacyChildKinds: Array<[kind: string, tools: Tool[]]> = [
    ['normal', []],
    ['timed', [timingTool('read_file', 'subagentStart')]],
  ]

  it.each(legacyChildKinds)('旧 host 无 caller id 时 %s child 可运行并持久化稳定 id', async (kind, tools) => {
    const runId = `run-legacy-${kind}`
    const trace: TraceEntry[] = []
    const { core, runtime } = childRuntime({
      runId,
      tools,
      hostHasLocalCapabilities: true,
      trace,
      fetchImpl: async (_url, init) => isChildRequest(body(init)) ? response('done') : response('# distilled skill'),
    })

    const result = await runtime.delegateAgents(
      { toolProfile: 'workspace_read', children: [{ objective: 'continue safely' }] },
      context(async () => ({ ok: true })),
    )

    expect(result.children[0]?.status).toBe('done')
    const node = core.delegation!.scheduler.snapshot(runId).find(({ path }) => path === 'root-01')
    const [continuation] = core.getSessionStore('session').store.getter(subagentContinuationsAtom)
    expect(node?.delegationCallId).toBe(`legacy:${runId}:1`)
    expect(continuation).toMatchObject({
      state: 'interrupted',
      spec: { parent: { delegationCallId: node?.delegationCallId } },
    })
    await runtime.dispose?.()
  })
})
