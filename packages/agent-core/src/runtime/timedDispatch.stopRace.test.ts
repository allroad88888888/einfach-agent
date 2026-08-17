import { describe, expect, it, vi } from 'vitest'
import { runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import type { Tool } from '../tools/types'
import { createCoreInstance } from './core/coreInstance'
import type { RecoveryWriteOutcome } from './recoveryWriter'
import { runSession } from './runToolLoop'
import { dispatchTimedTools } from './timedDispatch'
import { bootstrapToolLoop } from './toolLoopBootstrap'

const id = 'timed-stop-race'
const runId = 'timed-stop-race-run'

function seedSession(core: ReturnType<typeof createCoreInstance>): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'Timed stop race',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 1,
      updatedAt: 1,
    },
  })
}

function timedTool(timing: 'turnStart' | 'runEnd', execute: Tool['execute']): Tool {
  return {
    name: `timer-${timing}`,
    runtime: 'internal',
    skill: { description: timing, content: timing },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming: timing,
    execute,
  }
}

function saved(sessionId: string): RecoveryWriteOutcome {
  return { status: 'saved', sessionId, generation: 1, attempts: 1 }
}

function response(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('timed dispatch stop admission', () => {
  it('does not execute turnStart after its durability fence observes a stopped run', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    core.getSessionStore(id).store.setter(runAtom, { runId, status: 'running', turnId: 'turn-1' })
    let releaseFence: (() => void) | undefined
    let signalFenceReached: (() => void) | undefined
    const fenceReached = new Promise<void>((resolve) => { signalFenceReached = resolve })
    const fence = new Promise<void>((resolve) => { releaseFence = resolve })
    vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => {
      if (reason === 'tool_call_execution_started') {
        signalFenceReached?.()
        await fence
      }
      return saved(sessionId)
    })
    const boot = await bootstrapToolLoop(id, runId, {
      core,
      apiKey: 'key',
      signal: new AbortController().signal,
    })
    if (!boot) throw new Error('expected an active tool loop')

    try {
      const dispatch = dispatchTimedTools({
        base: boot.base,
        request: { sessionId: id, timing: 'turnStart' },
      })
      await fenceReached
      const run = core.getSessionStore(id).store.getter(runAtom)
      if (!run) throw new Error('expected active run')
      core.getSessionStore(id).store.setter(runAtom, { ...run, status: 'stopped' })
      releaseFence?.()

      await expect(dispatch).resolves.toEqual({ status: 'inactive', itemCount: 0 })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      releaseFence?.()
      boot.releaseTimedToolDispatcher()
      boot.base.pluginRun.dispose()
    }
  })

  it('still executes runEnd after normal completion', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('runEnd', execute)) })
    seedSession(core)

    await runSession(id, 'start', {
      core,
      apiKey: 'key',
      signal: new AbortController().signal,
      fetchImpl: async () => response(),
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('done')
  })
})
