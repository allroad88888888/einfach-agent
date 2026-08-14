import { describe, expect, it, vi } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import type { Tool } from '../tools/types'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
import { runSession, runToolLoop } from './runToolLoop'

function seedSession(core: CoreInstance, id: string, loadedTools: string[]): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'Fence liveness race',
      settings: { vendor: 'deepseek', model: 'test' },
      loadedTools,
      createdAt: 1,
      updatedAt: 1,
    },
  })
}

function testTool(name: string, execute: Tool['execute'], parallel = false): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: name },
    inputSchema: { type: 'object', additionalProperties: false },
    ...(parallel ? { execution: { mode: 'parallel' as const, effectKeys: [`race:${name}`] } } : {}),
    execute,
  }
}

function toolCallsResponse(calls: Array<{ id: string; name: string }>): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(({ id, name }) => ({
          id,
          type: 'function',
          function: { name, arguments: '{}' },
        })),
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function delayedExecutionFence(core: CoreInstance): { reached: Promise<void>; release(): void } {
  let reached = () => {}
  const waiting = new Promise<void>((resolve) => { reached = resolve })
  let release = () => {}
  const delay = new Promise<void>((resolve) => { release = resolve })
  const persist = core.persistence.persistRecovery.bind(core.persistence)
  vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => {
    if (reason !== 'tool_call_execution_started') return persist(sessionId, reason)
    reached()
    await delay
    return undefined
  })
  return { reached: waiting, release }
}

function hasReceipt(core: CoreInstance, id: string, callId: string): boolean {
  return core.getSessionStore(id).store.getter(itemsAtom).some(
    ({ item }) => item.role === 'tool' && item.tool_call_id === callId,
  )
}

describe('tool-call execution fence liveness admission', () => {
  it('serial execution does not start after the run is replaced while the fence awaits', async () => {
    const id = 'fence-serial-stale'
    const name = '__fence_serial__'
    const execute = vi.fn(() => ({ ok: true as const, data: 'unexpected' }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(testTool(name, execute)) })
    seedSession(core, id, [name])
    const fence = delayedExecutionFence(core)
    const running = runSession(id, 'run', {
      core,
      apiKey: 'key',
      signal: new AbortController().signal,
      fetchImpl: async () => toolCallsResponse([{ id: 'serial-call', name }]),
    })

    await fence.reached
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (!run) throw new Error('expected active run')
    setRun(id, { ...run, runId: 'replacement-run' }, core)
    fence.release()
    await running

    expect(execute).not.toHaveBeenCalled()
    expect(hasReceipt(core, id, 'serial-call')).toBe(false)
    expect(core.getSessionStore(id).store.getter(runAtom)).toMatchObject({ runId: 'replacement-run', status: 'running' })
  })

  it('parallel execution does not start after the run stops while the fence awaits', async () => {
    const id = 'fence-parallel-stopped'
    const first = '__fence_parallel_first__'
    const second = '__fence_parallel_second__'
    const executeFirst = vi.fn(() => ({ ok: true as const, data: 'unexpected' }))
    const executeSecond = vi.fn(() => ({ ok: true as const, data: 'unexpected' }))
    const core = createCoreInstance({
      registerTools: (registry) => {
        registry.register(testTool(first, executeFirst, true))
        registry.register(testTool(second, executeSecond, true))
      },
    })
    seedSession(core, id, [first, second])
    const fence = delayedExecutionFence(core)
    const running = runSession(id, 'run', {
      core,
      apiKey: 'key',
      signal: new AbortController().signal,
      fetchImpl: async () => toolCallsResponse([
        { id: 'parallel-first', name: first },
        { id: 'parallel-second', name: second },
      ]),
    })

    await fence.reached
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (!run) throw new Error('expected active run')
    setRun(id, { ...run, status: 'stopped' }, core)
    fence.release()
    await running

    expect(executeFirst).not.toHaveBeenCalled()
    expect(executeSecond).not.toHaveBeenCalled()
    expect(hasReceipt(core, id, 'parallel-first')).toBe(false)
    expect(hasReceipt(core, id, 'parallel-second')).toBe(false)
    expect(core.getSessionStore(id).store.getter(runAtom)).toMatchObject({ status: 'stopped' })
  })

  it('resumed execution does not start after aborting while the fence awaits', async () => {
    const id = 'fence-resumed-aborted'
    const runId = 'resumed-run'
    const name = '__fence_resumed__'
    const execute = vi.fn(() => ({ ok: true as const, data: 'unexpected' }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(testTool(name, execute)) })
    seedSession(core, id, [name])
    core.getSessionStore(id).store.setter(itemsAtom, [
      { id: 'user', createdAt: 1, item: { role: 'user', content: 'resume' } },
      {
        id: 'assistant',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'resumed-call', type: 'function', function: { name, arguments: '{}' } }],
        },
      },
    ])
    setRun(id, { runId, status: 'running', turnId: 'user' }, core)
    const controller = new AbortController()
    const fence = delayedExecutionFence(core)
    const running = runToolLoop(id, runId, {
      core,
      apiKey: 'key',
      signal: controller.signal,
      fetchImpl: async () => { throw new Error('model must not run after abort') },
      resumeToolCall: { callId: 'resumed-call', toolName: name, args: {} },
    })

    await fence.reached
    controller.abort()
    fence.release()
    await running

    expect(execute).not.toHaveBeenCalled()
    expect(hasReceipt(core, id, 'resumed-call')).toBe(false)
    expect(core.getSessionStore(id).store.getter(runAtom)).toMatchObject({ status: 'stopped' })
  })
})
