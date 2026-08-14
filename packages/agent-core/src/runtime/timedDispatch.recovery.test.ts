import { describe, expect, it, vi } from 'vitest'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import { createMemoryRecoveryDriver, type RecoveryDriver, type RecoverySaveResult } from '../state/persistence/recoveryDriver'
import type { ConversationItem } from '../state/core.type'
import type { Tool } from '../tools/types'
import type { ToolCallTiming } from '../tools/toolCallTiming'
import { bootstrapToolLoop } from './toolLoopBootstrap'
import { createCoreInstance } from './core/coreInstance'
import type { RecoveryWriteOutcome } from './recoveryWriter'
import { runSession, runToolLoop } from './runToolLoop'
import { dispatchTimedTools } from './timedDispatch'

const id = 'timed-recovery'
const runId = 'run-timed-recovery'

function timedTool(timing: ToolCallTiming, execute: Tool['execute'], name = 'timer'): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: 'timer', content: 'timer' },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming: timing,
    execute,
  }
}

function seedSession(core: ReturnType<typeof createCoreInstance>): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'Timed recovery',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 1,
      updatedAt: 1,
    },
  })
}

function response(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function toolCallsResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'load-timer',
          type: 'function',
          function: { name: 'request_tool_schema', arguments: '{"toolName":"timer"}' },
        }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function saved(sessionId: string): RecoveryWriteOutcome {
  return { status: 'saved', sessionId, generation: 1, attempts: 1 }
}

function failed(sessionId: string): RecoveryWriteOutcome {
  return { status: 'error', sessionId, error: new Error('disk unavailable') }
}

function tombstoned(sessionId: string): RecoveryWriteOutcome {
  return { status: 'tombstoned', sessionId }
}

function alwaysStaleDriver(): RecoveryDriver {
  const base = createMemoryRecoveryDriver()
  return {
    ...base,
    saveLatest: async (_sessionId, candidate): Promise<RecoverySaveResult> => (
      { status: 'stale', currentGeneration: candidate.generation }
    ),
  }
}

async function recoveredBoot(
  core: ReturnType<typeof createCoreInstance>,
  outcomes: Record<string, { state: 'outcomeKnown' | 'outcomeUnknown'; updatedAt: number }>,
  items: ConversationItem[],
) {
  core.getSessionStore(id).store.setter(itemsAtom, items)
  core.getSessionStore(id).store.setter(runAtom, {
    runId,
    status: 'running',
    turnId: 'turn-1',
    timedDispatchEpoch: 4,
    toolCallOutcomes: outcomes,
  })
  const boot = await bootstrapToolLoop(id, runId, {
    core,
    apiKey: 'key',
    signal: new AbortController().signal,
  })
  if (!boot) throw new Error('expected active tool loop')
  return boot
}

describe('timed dispatch recovery fences', () => {
  it.each((['sessionStart', 'turnStart'] as const).flatMap((timing) => (
    (['error', 'stale', 'tombstoned', 'rejected'] as const).map((failure) => [timing, failure] as const)
  )))('%s %s pre-execution failure prevents execution and model I/O', async (timing, failure) => {
      const execute = vi.fn(() => ({ ok: true as const }))
      const fetchImpl = vi.fn(async () => response())
      const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool(timing, execute)) })
      seedSession(core)
      if (failure === 'stale') {
        core.persistence.configure({
          recovery: alwaysStaleDriver(),
          recoveryStore: (sessionId) => sessionId === id ? core.findSessionStore(id)?.store : undefined,
        })
      } else {
        vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => {
          if (reason !== 'tool_call_execution_started') return saved(sessionId)
          if (failure === 'rejected') throw new Error('recovery writer rejected')
          return failure === 'tombstoned' ? tombstoned(sessionId) : failed(sessionId)
        })
      }

      await runSession(id, 'start', { core, apiKey: 'key', signal: new AbortController().signal, fetchImpl })

      expect(execute).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
  })

  it('post-result durability failure blocks the next model request after recording the timed receipt', async () => {
    const execute = vi.fn(() => ({ ok: true as const, data: { fired: true } }))
    const fetchImpl = vi.fn(async () => response())
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => (
      reason === 'timed_tool_result_saved' ? failed(sessionId) : saved(sessionId)
    ))

    await runSession(id, 'start', { core, apiKey: 'key', signal: new AbortController().signal, fetchImpl })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(core.getSessionStore(id).store.getter(itemsAtom)).toEqual(expect.arrayContaining([
      expect.objectContaining({ item: expect.objectContaining({ tool_call_id: expect.stringMatching(/^timed:turnStart:/) }) }),
    ]))
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
  })

  it('persists a normal timed result with the next durable logical-request epoch', async () => {
    const execute = vi.fn(() => ({ ok: true as const, data: { fired: true } }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    const recovery = createMemoryRecoveryDriver()
    seedSession(core)
    core.persistence.configure({
      recovery,
      recoveryStore: (sessionId) => sessionId === id ? core.findSessionStore(id)?.store : undefined,
    })

    await runSession(id, 'start', {
      core,
      apiKey: 'key',
      signal: new AbortController().signal,
      fetchImpl: async () => response(),
    })

    const snapshot = await recovery.loadLatest(id)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(snapshot).toMatchObject({
      values: {
        run: { timedDispatchEpoch: 1, toolCallOutcomes: expect.objectContaining({}) },
        conversation: { items: expect.arrayContaining([
          expect.objectContaining({ item: expect.objectContaining({ tool_call_id: expect.stringMatching(/^timed:turnStart:.+:0:timer$/) }) }),
        ]) },
      },
    })
  })

  it('runs one timed effect for each subsequent logical model request after epoch advance', async () => {
    const execute = vi.fn(() => ({ ok: true as const, data: { fired: true } }))
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(toolCallsResponse())
      .mockResolvedValueOnce(response())
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    const capturedTimedIds: string[] = []
    vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId) => {
      capturedTimedIds.push(...Object.keys(
        core.getSessionStore(sessionId).store.getter(runAtom)?.toolCallOutcomes ?? {},
      ).filter((callId) => callId.startsWith('timed:turnStart:')))
      return saved(sessionId)
    })

    await runSession(id, 'start', { core, apiKey: 'key', signal: new AbortController().signal, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect([...new Set(capturedTimedIds)].map((callId) => callId.replace(/:[^:]+:(\d+):timer$/, ':$1:timer'))).toEqual(['timed:turnStart:0:timer', 'timed:turnStart:1:timer'])
    expect(core.getSessionStore(id).store.getter(runAtom)?.timedDispatchEpoch).toBe(2)
  })

  it('reuses a persisted turn epoch to skip a completed receipt after recovery', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    const callId = `timed:turnStart:${runId}:4:timer`
    const boot = await recoveredBoot(core, { [callId]: { state: 'outcomeKnown', updatedAt: 1 } }, [{
      id: 'receipt-1',
      createdAt: 1,
      item: { role: 'tool', tool_call_id: callId, content: '{"fired":true}' },
    }])

    try {
      await expect(dispatchTimedTools({
        base: boot.base,
        checkpoints: boot.checkpoints,
        request: { sessionId: id, timing: 'turnStart' },
      })).resolves.toEqual({ status: 'dispatched', itemCount: 0 })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      boot.releaseTimedToolDispatcher()
      boot.base.pluginRun.dispose()
    }
  })

  it('resumes a known timed receipt with one model request and no executor replay', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const fetchImpl = vi.fn(async () => response())
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    const callId = `timed:turnStart:${runId}:4:timer`
    core.getSessionStore(id).store.setter(itemsAtom, [{
      id: 'receipt-1',
      createdAt: 1,
      item: { role: 'tool', tool_call_id: callId, content: '{"fired":true}' },
    }])
    core.getSessionStore(id).store.setter(runAtom, {
      runId,
      status: 'running',
      turnId: 'turn-1',
      timedDispatchEpoch: 4,
      toolCallOutcomes: { [callId]: { state: 'outcomeKnown', updatedAt: 1 } },
    })

    await runToolLoop(id, runId, { core, apiKey: 'key', signal: new AbortController().signal, fetchImpl })

    expect(execute).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails closed when any earlier timed epoch has an unknown outcome', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    const previous = `timed:turnStart:${runId}:3:timer`
    const boot = await recoveredBoot(core, { [previous]: { state: 'outcomeUnknown', updatedAt: 1 } }, [])

    try {
      await expect(dispatchTimedTools({
        base: boot.base,
        checkpoints: boot.checkpoints,
        request: { sessionId: id, timing: 'turnStart' },
      })).resolves.toMatchObject({ status: 'interrupted' })
      expect(execute).not.toHaveBeenCalled()
      expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
    } finally {
      boot.releaseTimedToolDispatcher()
      boot.base.pluginRun.dispose()
    }
  })

  it('gates every timing bucket before a resumed run can make model I/O', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const fetchImpl = vi.fn(async () => response())
    const core = createCoreInstance({ registerTools: (registry) => registry.register(timedTool('turnStart', execute)) })
    seedSession(core)
    core.getSessionStore(id).store.setter(runAtom, {
      runId,
      status: 'running',
      turnId: 'turn-1',
      timedDispatchEpoch: 4,
      toolCallOutcomes: {
        [`timed:turnEnd:${runId}:timer`]: { state: 'outcomeUnknown', updatedAt: 1 },
      },
    })

    await runToolLoop(id, runId, { core, apiKey: 'key', signal: new AbortController().signal, fetchImpl })

    expect(execute).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
  })

})
