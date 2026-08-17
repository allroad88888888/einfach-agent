// 工具副作用的恢复安全黑箱：跨 Core 水合后只允许确定的继续，绝不猜测重放。

import { describe, expect, it, vi } from 'vitest'
import type { ConversationItem } from '../state/core.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import {
  createMemoryRecoveryDriver,
  type RecoveryDriver,
} from '../state/persistence/recoveryDriver'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import type { Tool } from '../tools/types'
import { createCore } from './core/createCore'
import { textResponse } from './toolAvailability.testFixtures'

const TOOL = 'write_file'
const CALL_ID = 'dangerous-call'

type TestCore = ReturnType<typeof createCore>
type Outcome = 'notStarted' | 'outcomeKnown' | 'outcomeUnknown' | undefined
type Failure = 'error' | 'stale' | 'tombstoned'

function dangerousTool(execute: () => { ok: true; data: unknown }): Tool {
  return {
    name: TOOL,
    runtime: 'internal',
    skill: { description: '写文件（危险测试替身）', content: '执行会产生副作用' },
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute,
  }
}

function emptySessions(): SessionsPersistence {
  return {
    loadSessions: async () => [],
    saveSessions: async () => {},
    loadWorkspaces: async () => [],
    saveWorkspaces: async () => {},
  }
}

function wirePersistence(
  core: TestCore,
  recovery: RecoveryDriver,
  sessions = emptySessions(),
): void {
  core.persistence.configure({
    sessions,
    recovery,
    recoveryStore: (sessionId) => core.findSessionStore(sessionId)?.store,
  })
}

function seedInterrupted(core: TestCore, sessionId: string, outcome: Outcome): void {
  const entries: ConversationItem[] = [
    { id: 'user', createdAt: 1, item: { role: 'user' as const, content: '写文件' } },
    {
      id: 'assistant',
      createdAt: 2,
      item: {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: CALL_ID, type: 'function' as const, function: { name: TOOL, arguments: '{"path":"a.txt"}' } }],
      },
    },
  ]
  if (outcome === 'outcomeKnown') {
    entries.push({
      id: 'receipt',
      createdAt: 3,
      item: { role: 'tool' as const, tool_call_id: CALL_ID, content: '{"written":true}' },
    })
  }
  const store = core.getSessionStore(sessionId).store
  store.setter(itemsAtom, entries)
  store.setter(runAtom, {
    runId: 'interrupted-run',
    status: 'interrupted',
    turnId: 'user',
    startedAt: 1,
    ...(outcome === undefined ? {} : { toolCallOutcomes: { [CALL_ID]: { state: outcome, updatedAt: 2 } } }),
  })
}

function seedConfirmation(core: TestCore, sessionId: string): void {
  seedInterrupted(core, sessionId, 'notStarted')
  core.getSessionStore(sessionId).store.setter(runAtom, {
    runId: 'confirmation-run',
    status: 'waiting_confirmation',
    turnId: 'user',
    startedAt: 1,
    pendingToolConfirmation: { callId: CALL_ID, toolName: TOOL, args: { path: 'a.txt' } },
  })
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function recoveringCore(requests: { count: number }) {
  return createCore({
    config: {
      modelCredentials: { deepseek: 'key' },
      fetchImpl: async () => {
        requests.count += 1
        return textResponse('恢复完成')
      },
    },
  })
}

async function persistThenHydrate(outcome: Outcome, requests: { count: number }) {
  const recovery = createMemoryRecoveryDriver()
  const sessions = emptySessions()
  const origin = createCore()
  const sessionId = origin.newSession({ settings: { vendor: 'deepseek', model: 'test-model' } })
  seedInterrupted(origin, sessionId, outcome)
  wirePersistence(origin, recovery, sessions)
  await origin.persistence.persistRecovery(sessionId)
  await origin.persistence.flushRecovery()

  const restored = recoveringCore(requests)
  wirePersistence(restored, recovery, sessions)
  await restored.persistence.hydrate()
  restored.selectSession(sessionId)
  return { recovery, restored, sessionId }
}

function failingRecovery(failure: Failure, savesBeforeFailure = 0): RecoveryDriver {
  const base = createMemoryRecoveryDriver()
  let saves = 0
  return {
    ...base,
    saveLatest: async (sessionId, snapshot) => {
      saves += 1
      if (saves <= savesBeforeFailure) return base.saveLatest(sessionId, snapshot)
      if (failure === 'error') throw new Error('persistence offline')
      return failure === 'stale'
        ? { status: 'stale', currentGeneration: snapshot.generation }
        : { status: 'tombstoned' }
    },
  }
}

describe('recovery tool side-effect safety', () => {
  it('records notStarted as a no-execution receipt before independently hydrated continuation', async () => {
    const requests = { count: 0 }
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const { recovery, restored, sessionId } = await persistThenHydrate('notStarted', requests)
    restored.tools.register(dangerousTool(execute))

    expect(restored.continueRecoveredSession(sessionId)).toMatchObject({ status: 'continued' })
    await waitUntil(() => restored.getSessionStore(sessionId).store.getter(runAtom)?.status === 'done', 'continued run')

    expect(execute).not.toHaveBeenCalled()
    expect(requests.count).toBe(1)
    expect(await recovery.loadLatest(sessionId)).toMatchObject({
      values: { conversation: { items: expect.arrayContaining([
        expect.objectContaining({ item: expect.objectContaining({ role: 'tool', tool_call_id: CALL_ID, content: expect.stringContaining('not_started') }) }),
      ]) } },
    })
  })

  it('does not replay an outcomeKnown effect after independent hydration', async () => {
    const requests = { count: 0 }
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const { restored, sessionId } = await persistThenHydrate('outcomeKnown', requests)
    restored.tools.register(dangerousTool(execute))

    expect(restored.continueRecoveredSession(sessionId)).toMatchObject({ status: 'continued' })
    await waitUntil(() => restored.getSessionStore(sessionId).store.getter(runAtom)?.status === 'done', 'known-outcome continuation')

    expect(execute).not.toHaveBeenCalled()
    expect(requests.count).toBe(1)
  })

  it.each<[Outcome]>([['outcomeUnknown'], [undefined]])(
    'blocks uncertain or missing tool facts without model or side-effect execution (%s)',
    async (outcome) => {
      const requests = { count: 0 }
      const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
      const { restored, sessionId } = await persistThenHydrate(outcome, requests)
      restored.tools.register(dangerousTool(execute))

      expect(restored.continueRecoveredSession(sessionId)).toMatchObject({ status: 'reconciliation_required' })
      expect(restored.getSessionStore(sessionId).store.getter(runAtom)?.status).toBe('interrupted')
      expect(execute).not.toHaveBeenCalled()
      expect(requests.count).toBe(0)
    },
  )

  it('rejecting a recovered confirmation never executes the dangerous tool', async () => {
    const recovery = createMemoryRecoveryDriver()
    const sessions = emptySessions()
    const origin = createCore()
    const sessionId = origin.newSession({ settings: { vendor: 'deepseek', model: 'test-model' } })
    seedConfirmation(origin, sessionId)
    wirePersistence(origin, recovery, sessions)
    await origin.persistence.persistRecovery(sessionId)

    const requests = { count: 0 }
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const restored = recoveringCore(requests)
    restored.tools.register(dangerousTool(execute))
    wirePersistence(restored, recovery, sessions)
    await restored.persistence.hydrate()
    restored.selectSession(sessionId)
    restored.confirmTool(false)
    await waitUntil(() => restored.getSessionStore(sessionId).store.getter(runAtom)?.status === 'done', 'rejected confirmation')

    expect(execute).not.toHaveBeenCalled()
    expect(requests.count).toBe(1)
  })

  it.each<[Failure]>([['error'], ['stale'], ['tombstoned']])(
    'fails closed at model and tool durability boundaries (%s)',
    async (failure) => {
      const modelRequests = { count: 0 }
      const modelCore = recoveringCore(modelRequests)
      const modelSession = modelCore.newSession({ settings: { vendor: 'deepseek', model: 'test-model' } })
      wirePersistence(modelCore, failingRecovery(failure))
      modelCore.sendMessage('必须先持久化')
      await waitUntil(() => modelCore.getSessionStore(modelSession).store.getter(runAtom)?.status === 'interrupted', 'model interruption')
      expect(modelRequests.count).toBe(0)

      const toolRequests = { count: 0 }
      const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
      const toolCore = recoveringCore(toolRequests)
      const toolSession = toolCore.newSession({ settings: { vendor: 'deepseek', model: 'test-model' } })
      toolCore.tools.register(dangerousTool(execute))
      wirePersistence(toolCore, failingRecovery(failure, 1))
      seedConfirmation(toolCore, toolSession)
      toolCore.confirmTool(true)
      await waitUntil(() => toolCore.getSessionStore(toolSession).store.getter(runAtom)?.status === 'interrupted', 'tool interruption')
      expect(execute).not.toHaveBeenCalled()
      expect(toolRequests.count).toBe(0)
    },
  )
})
