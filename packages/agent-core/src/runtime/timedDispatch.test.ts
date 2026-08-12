import { describe, expect, it, vi } from 'vitest'
import { checkpointsAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import type { Tool } from '../tools/types'
import type { ToolCallTiming } from '../tools/toolCallTiming'
import { createCoreInstance } from './core/coreInstance'
import type { CorePlugin } from './core/pluginHost'
import { runSession } from './runToolLoop'

function timedTool(name: string, callTiming: ToolCallTiming, execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 测试工具`, content: name },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming,
    execute,
  }
}

function seedSession(core: ReturnType<typeof createCoreInstance>, id: string): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'timed dispatch',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

function textResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function toolCallIds(core: ReturnType<typeof createCoreInstance>, id: string): string[] {
  return core.getSessionStore(id).store.getter(itemsAtom)
    .flatMap(({ item }) => item.role === 'tool' ? [item.tool_call_id] : [])
}

describe('到点工具分派', () => {
  it('在五个主干时点按注册顺序执行，失败记录后仍继续，并把结果写进 checkpoint', async () => {
    const id = 'timed-five-points'
    const order: string[] = []
    const core = createCoreInstance({
      registerTools(registry) {
        registry.register(timedTool('session_hook', 'sessionStart', () => { order.push('session'); return { ok: true } }))
        registry.register(timedTool('run_start_hook', 'runStart', () => { order.push('runStart'); return { ok: true } }))
        registry.register(timedTool('turn_first', 'turnStart', () => { order.push('turn:first'); return { ok: true } }))
        registry.register(timedTool('turn_broken', 'turnStart', () => { order.push('turn:broken'); throw new Error('到点失败') }))
        registry.register(timedTool('turn_after_failure', 'turnStart', () => { order.push('turn:after'); return { ok: true } }))
        registry.register(timedTool('turn_end_hook', 'turnEnd', () => { order.push('turnEnd'); return { ok: true } }))
        registry.register(timedTool('run_end_hook', 'runEnd', () => { order.push('runEnd'); return { ok: true } }))
      },
    })
    seedSession(core, id)

    await runSession(id, '开始', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => textResponse('完成'),
      core,
    })

    expect(order).toEqual(['session', 'runStart', 'turn:first', 'turn:broken', 'turn:after', 'turnEnd', 'runEnd'])
    const ids = toolCallIds(core, id)
    expect(ids).toHaveLength(7)
    expect(ids[0]).toBe('timed:sessionStart:session_hook')
    expect(ids[1]).toMatch(/^timed:runStart:.+:run_start_hook$/)
    expect(ids[2]).toMatch(/^timed:turnStart:.+:turn_first$/)
    expect(ids[3]).toMatch(/^timed:turnStart:.+:turn_broken$/)
    expect(ids[4]).toMatch(/^timed:turnStart:.+:turn_after_failure$/)
    expect(ids[5]).toMatch(/^timed:turnEnd:.+:turn_end_hook$/)
    expect(ids[6]).toMatch(/^timed:runEnd:.+:run_end_hook$/)
    const broken = core.getSessionStore(id).store.getter(itemsAtom).find(({ item }) => item.role === 'tool' && item.tool_call_id === ids[3])?.item
    expect(broken?.role === 'tool' ? JSON.parse(broken.content) : undefined).toEqual({ error: '到点失败' })
    const items = core.getSessionStore(id).store.getter(itemsAtom)
    expect(core.getSessionStore(id).store.getter(checkpointsAtom).at(-1)?.items).toEqual(items)
  })

  it('sessionStart 根据既有 timeline 只执行一次，run 边界每个 run 各执行一次', async () => {
    const id = 'timed-session-once'
    const calls = { session: 0, runStart: 0, runEnd: 0 }
    const core = createCoreInstance({
      registerTools(registry) {
        registry.register(timedTool('once_per_session', 'sessionStart', () => ({ ok: true, data: ++calls.session })))
        registry.register(timedTool('once_per_run_start', 'runStart', () => ({ ok: true, data: ++calls.runStart })))
        registry.register(timedTool('once_per_run_end', 'runEnd', () => ({ ok: true, data: ++calls.runEnd })))
      },
    })
    seedSession(core, id)
    const options = { signal: new AbortController().signal, apiKey: 'k', fetchImpl: async () => textResponse('完成'), core }

    await runSession(id, '第一轮', options)
    await runSession(id, '第二轮', options)

    expect(calls).toEqual({ session: 1, runStart: 2, runEnd: 2 })
    expect(toolCallIds(core, id).filter((callId) => callId === 'timed:sessionStart:once_per_session')).toHaveLength(1)
  })

  it('风险工具不走 beforeToolCall 或确认门，只记录拒绝结果并继续 run', async () => {
    const id = 'timed-risk-refusal'
    const beforeToolCall = vi.fn()
    const execute = vi.fn(() => ({ ok: true as const }))
    const plugin: CorePlugin = {
      activate: (api) => api.hook('beforeToolCall', () => { beforeToolCall(); return undefined }),
    }
    const core = createCoreInstance({
      plugins: [plugin],
      registerTools: (registry) => registry.register(timedTool('shell_linux', 'sessionStart', execute)),
    })
    seedSession(core, id)

    await runSession(id, '开始', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => textResponse('完成'),
      core,
    })

    expect(execute).not.toHaveBeenCalled()
    expect(beforeToolCall).not.toHaveBeenCalled()
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('done')
    const item = core.getSessionStore(id).store.getter(itemsAtom).find(({ item: entry }) => (
      entry.role === 'tool' && entry.tool_call_id === 'timed:sessionStart:shell_linux'
    ))?.item
    expect(item?.role === 'tool' ? JSON.parse(item.content) : undefined).toEqual({
      error: '到点工具 shell_linux 因风险等级 dangerous 被拒绝执行',
      details: { timing: 'sessionStart', risk: 'dangerous' },
    })
  })
})
