import { describe, expect, it, vi } from 'vitest'
import { runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import type { Tool } from '../tools/types'
import { createCoreInstance } from './core/coreInstance'
import type { RecoveryWriteOutcome } from './recoveryWriter'
import { runSession } from './runToolLoop'

const id = 'timed-turn-end-recovery'

function timedTool(name: string, callTiming: 'turnStart' | 'turnEnd', execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: name },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming,
    execute,
  }
}

function seedSession(core: ReturnType<typeof createCoreInstance>): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'Timed turn-end recovery',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 1,
      updatedAt: 1,
    },
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

describe('turnEnd timed recovery fence', () => {
  it.each(['error', 'stale', 'tombstoned'] as const)(
    '%s exits before another timed call or model request',
    async (failure) => {
      const turnStart = vi.fn(() => ({ ok: true as const }))
      const turnEnd = vi.fn(() => ({ ok: true as const }))
      const fetchImpl = vi.fn(async () => toolCallsResponse())
      const core = createCoreInstance({
        registerTools: (registry) => {
          registry.register(timedTool('start-timer', 'turnStart', turnStart))
          registry.register(timedTool('end-timer', 'turnEnd', turnEnd))
        },
      })
      seedSession(core)
      vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => {
        if (reason !== 'tool_call_execution_started') return saved(sessionId)
        const facts = core.getSessionStore(id).store.getter(runAtom)?.toolCallOutcomes ?? {}
        if (!Object.keys(facts).some((callId) => callId.startsWith('timed:turnEnd:'))) return saved(sessionId)
        if (failure === 'stale') return { status: 'stale', sessionId } as unknown as RecoveryWriteOutcome
        return failure === 'tombstoned'
          ? { status: 'tombstoned', sessionId }
          : { status: 'error', sessionId, error: new Error('disk unavailable') }
      })

      await runSession(id, 'start', { core, apiKey: 'key', signal: new AbortController().signal, fetchImpl })

      expect(turnStart).toHaveBeenCalledTimes(1)
      expect(turnEnd).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
    },
  )
})
