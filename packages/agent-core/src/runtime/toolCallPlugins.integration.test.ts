import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '../tools/types'
import { activeSessionIdAtom, sessionsAtom } from '../state/rootStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCore } from './core/createCore'
import type { CoreInstance } from './core/coreInstance'
import { definePlugin } from './core/pluginContracts'
import type { CorePlugin } from './core/pluginHost'
import { runSession } from './modelRun'

function seedSession(core: CoreInstance, id: string): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'tool hook test',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

function toolCallsResponse(calls: Array<{ name: string; args: unknown; id: string }>): Response {
  return new Response(JSON.stringify({
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
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function textResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function toolResultPayload(body: string, callId: string): unknown {
  const messages = (JSON.parse(body) as { messages: Array<{ role?: string; tool_call_id?: string; content?: string }> }).messages
  const result = messages.find((message) => message.role === 'tool' && message.tool_call_id === callId)
  return JSON.parse(result?.content ?? 'null')
}

function testTool(name: string, execute: Tool['execute'], execution?: Tool['execution']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: name },
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', default: 'schema default' } },
      additionalProperties: false,
    },
    ...(execution ? { execution } : {}),
    execute,
  }
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${description}`)
}

describe('tool-call plugin production integration', () => {
  it('gives hooks normalized immutable args and returns the after patch in the next request', async () => {
    const name = '__tool_hook_echo__'
    const execute = vi.fn(() => ({ ok: true as const, data: { source: 'tool' } }))
    const seen: Array<{ args: unknown; result?: unknown; frozen: boolean }> = []
    const plugin: CorePlugin = {
      activate(api) {
        api.hook('beforeToolCall', (_ctx, event) => {
          if (event.toolName === name) seen.push({ args: event.args, frozen: Object.isFrozen(event.args) })
          return undefined
        })
        api.hook('afterToolCall', (_ctx, event) => {
          if (event.toolName !== name) return undefined
          seen[0].result = event.result
          return { data: { source: 'plugin' } }
        })
      },
    }
    const core = createCore({ plugins: [plugin], registerTools: (registry) => registry.register(testTool(name, execute)) })
    seedSession(core, 'patched')
    let requests = 0
    let thirdRequest = ''
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests += 1
      if (requests === 1) return toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: name }, id: 'load' }])
      if (requests === 2) return toolCallsResponse([{ name, args: {}, id: 'call' }])
      thirdRequest = String(init?.body)
      return textResponse('done')
    }

    try {
      await runSession('patched', 'run', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

      expect(execute).toHaveBeenCalledWith({ value: 'schema default' }, expect.anything())
      expect(seen).toEqual([{
        args: { value: 'schema default' },
        result: { ok: true, data: { source: 'tool' } },
        frozen: true,
      }])
      expect(toolResultPayload(thirdRequest, 'call')).toEqual({ source: 'plugin' })
    } finally {
      core.plugins.dispose()
    }
  })

  it('blocks an MCP write before confirmation or execution and returns a deterministic result', async () => {
    const name = 'mcp__test__blocked_action'
    const execute = vi.fn(() => ({ ok: true as const, data: 'should not run' }))
    const plugin: CorePlugin = {
      activate(api) {
        api.hook('beforeToolCall', (_ctx, event) => (
          event.toolName === name ? { block: true, reason: 'blocked by policy' } : undefined
        ))
      },
    }
    const core = createCore({ plugins: [plugin], registerTools: (registry) => registry.register(testTool(name, execute)) })
    seedSession(core, 'blocked')
    let requests = 0
    let thirdRequest = ''
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests += 1
      if (requests === 1) return toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: name }, id: 'load' }])
      if (requests === 2) return toolCallsResponse([{ name, args: {}, id: 'blocked-call' }])
      thirdRequest = String(init?.body)
      return textResponse('recovered')
    }

    try {
      await runSession('blocked', 'run', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

      expect(execute).not.toHaveBeenCalled()
      expect(core.getSessionStore('blocked').store.getter(runAtom)?.status).toBe('done')
      expect(toolResultPayload(thirdRequest, 'blocked-call')).toEqual({
        error: 'blocked by policy',
        code: 'plugin_blocked',
      })
    } finally {
      core.plugins.dispose()
    }
  })

  // F2 卡的判据：外部（definePlugin 品牌）插件的 beforeToolCall 返回 {block:true} 必须**真的**
  // 拦下执行——从前公开面只有 onAfterToolCall，返回值被丢弃，第三方只能观察不能否决。
  // F2b 追加：同一次真实 run 里，它经 ctx.state 读得到会话 atom 值与跨会话 root 值，
  // 而 store / root / history 三个裸句柄仍然拿不到。
  it('lets an external definePlugin block a tool call end to end', async () => {
    const name = '__external_blocked_shell__'
    const execute = vi.fn(() => ({ ok: true as const, data: 'should not run' }))
    let hookContext: Record<string, unknown> | undefined
    let stateRead: { runId?: string; items: number; activeSessionId: string } | undefined
    const external = definePlugin({
      activate: (api) => api.hook('beforeToolCall', (ctx, event) => {
        hookContext = ctx as unknown as Record<string, unknown>
        stateRead = {
          runId: ctx.state.readSession('run')?.runId,
          items: ctx.state.readSession('items').length,
          activeSessionId: ctx.state.readRoot('activeSessionId'),
        }
        return event.toolName === name ? { block: true, reason: '第三方插件否决了这条命令' } : undefined
      }),
    })
    const core = createCore({ plugins: [external], registerTools: (registry) => registry.register(testTool(name, execute)) })
    seedSession(core, 'external-block')
    core.rootStore.setter(activeSessionIdAtom, 'external-block')
    let requests = 0
    let thirdRequest = ''
    const fetchImpl: typeof fetch = async (_url, init) => {
      requests += 1
      if (requests === 1) return toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: name }, id: 'load' }])
      if (requests === 2) return toolCallsResponse([{ name, args: {}, id: 'external-call' }])
      thirdRequest = String(init?.body)
      return textResponse('recovered')
    }

    try {
      await runSession('external-block', 'run', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

      expect(execute).not.toHaveBeenCalled()
      expect(toolResultPayload(thirdRequest, 'external-call')).toEqual({
        error: '第三方插件否决了这条命令',
        code: 'plugin_blocked',
      })
      // 真实 run 里拿不到裸句柄：放开的是能力，不是 einfach 的 Store（记账要留住，见
      // pluginHookContracts.ts 文件头）。
      expect(hookContext?.sessionId).toBe('external-block')
      expect(hookContext?.store).toBeUndefined()
      expect(hookContext?.root).toBeUndefined()
      expect(hookContext?.history).toBeUndefined()
      // 但受限的 state 面在真实 run 里确实读得到两个 store 的值（F2b）。
      // 读到的 run 就是本次 hook 所属的那一个（runSession 自己铸 runId，不是传进去的会话入口名）。
      expect(stateRead?.runId).toBe(hookContext?.runId)
      expect(typeof stateRead?.runId).toBe('string')
      expect(stateRead?.items).toBeGreaterThan(0)
      expect(stateRead?.activeSessionId).toBe('external-block')
    } finally {
      core.plugins.dispose()
    }
  })

  it('serializes parallel-capable calls when a tool lifecycle hook is installed', async () => {
    const firstName = '__hook_parallel_first__'
    const secondName = '__hook_parallel_second__'
    const order: string[] = []
    let release = () => {}
    const firstGate = new Promise<void>((resolve) => { release = resolve })
    const serializingPlugin: CorePlugin = {
      activate: (api) => api.hook('afterToolCall', () => undefined),
    }
    const core = createCore({
      plugins: [serializingPlugin],
      registerTools(registry) {
        registry.register(testTool(firstName, async () => {
          order.push('first:start')
          await firstGate
          order.push('first:finish')
          return { ok: true, data: 'first' }
        }, { mode: 'parallel' }))
        registry.register(testTool(secondName, () => {
          order.push('second')
          return { ok: true, data: 'second' }
        }, { mode: 'parallel' }))
      },
    })
    seedSession(core, 'serial-hooks')
    let requests = 0
    const fetchImpl: typeof fetch = async () => {
      requests += 1
      if (requests === 1) return toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: firstName }, id: 'load-first' }])
      if (requests === 2) return toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: secondName }, id: 'load-second' }])
      if (requests === 3) return toolCallsResponse([
        { name: firstName, args: {}, id: 'first-call' },
        { name: secondName, args: {}, id: 'second-call' },
      ])
      return textResponse('done')
    }

    const running = runSession('serial-hooks', 'run', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })
    try {
      await waitFor(() => order.includes('first:start'), 'first parallel-capable tool')
      expect(order).toEqual(['first:start'])
      release()
      await running
      expect(order).toEqual(['first:start', 'first:finish', 'second'])
    } finally {
      release()
      await running
      core.plugins.dispose()
    }
  })

  it('does not run beforeToolCall again after the user confirms a paused MCP call', async () => {
    const name = 'mcp__test__confirmed_action'
    const before = vi.fn()
    const execute = vi.fn(() => ({ ok: true as const, data: 'executed once' }))
    const confirmationPlugin: CorePlugin = {
      activate: (api) => api.hook('beforeToolCall', (_ctx, event) => {
        if (event.toolName === name) before()
        return undefined
      }),
    }
    const core = createCore({
      config: { modelCredentials: { deepseek: 'k' } },
      plugins: [confirmationPlugin],
      registerTools: (registry) => registry.register(testTool(name, execute)),
    })
    let requests = 0
    core.config.fetchImpl = async () => {
      requests += 1
      if (requests === 1) return toolCallsResponse([{ name: 'request_tool_schema', args: { toolName: name }, id: 'load' }])
      if (requests === 2) return toolCallsResponse([{ name, args: {}, id: 'confirm-call' }])
      return textResponse('confirmed')
    }
    const id = core.newSession({ settings: { vendor: 'deepseek', model: 'x' } })

    try {
      core.sendMessage('run')
      await waitFor(() => core.getSessionStore(id).store.getter(runAtom)?.status === 'waiting_confirmation', 'confirmation')
      expect(before).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()

      core.confirmTool(true)
      await waitFor(() => core.getSessionStore(id).store.getter(runAtom)?.status === 'done', 'confirmation resume')

      expect(before).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(core.getSessionStore(id).store.getter(itemsAtom).some(({ item }) => item.role === 'tool' && item.tool_call_id === 'confirm-call')).toBe(true)
    } finally {
      core.plugins.dispose()
    }
  })
})
