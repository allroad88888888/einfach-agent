import { compactContextTool } from '@einfach-agent/tools-agents'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../state/persistence/recoveryDriver'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'
import { contextCheckpointAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCore } from './core/createCore'
import { jsonResponse } from './modelRun.testHarness'
import { runSession } from './runToolLoop'

type TestCore = ReturnType<typeof createCore>
type CrashPhase = 'summary' | 'checkpoint' | 'receipt'

function wirePersistence(core: TestCore, recovery: RecoveryDriver): void {
  core.persistence.configure({
    sessions: {
      loadSessions: async () => [], saveSessions: async () => {},
      loadWorkspaces: async () => [], saveWorkspaces: async () => {},
    },
    recovery,
    recoveryStore: (id) => core.findSessionStore(id)?.store,
  })
}

/** Fork the actual durable state at the crash boundary, before abort cleanup can change it. */
async function interruptedSnapshot(phase: CrashPhase): Promise<RecoverySnapshotV1> {
  const recovery = createMemoryRecoveryDriver()
  const controller = new AbortController()
  let snapshot: RecoverySnapshotV1 | undefined
  const capture = async () => {
    snapshot = await recovery.loadLatest(id)
    controller.abort()
  }
  const origin = createCore({ registerTools: (tools) => tools.register({
    ...compactContextTool,
    async execute(args, ctx) {
      const result = await compactContextTool.execute(args, ctx)
      if (phase === 'checkpoint') {
        await origin.persistence.persistRecovery(id, 'test_checkpoint_committed')
        await capture()
      }
      return result
    },
  }) })
  const id = origin.newSession({ settings: { vendor: 'deepseek', model: 'x', max_tokens: 48_000 } })
  wirePersistence(origin, recovery)
  let requests = 0
  await runSession(id, 'x'.repeat(60_000), {
    core: origin, apiKey: 'key', signal: controller.signal,
    fetchImpl: async () => {
      requests += 1
      if (phase === 'summary' || (phase === 'receipt' && requests === 2)) await capture()
      return jsonResponse('Saved task and next action.')
    },
  })
  expect(snapshot).toBeDefined()
  return snapshot!
}

async function restore(snapshot: RecoverySnapshotV1) {
  const recovery = createMemoryRecoveryDriver()
  await recovery.saveLatest(snapshot.sessionId, snapshot)
  const fetchImpl = vi.fn(async () => jsonResponse('Resumed task and next action.'))
  const core = createCore({
    registerTools: (tools) => tools.register(compactContextTool),
    config: { modelCredentials: { deepseek: 'key' }, fetchImpl },
  })
  wirePersistence(core, recovery)
  await core.persistence.hydrate()
  return { core, recovery, fetchImpl, id: snapshot.sessionId, store: core.getSessionStore(snapshot.sessionId).store }
}

describe('main compaction crash recovery', () => {
  it.each<CrashPhase>(['summary', 'checkpoint', 'receipt'])(
    'continues an independently hydrated snapshot interrupted during %s',
    async (phase) => {
      const snapshot = await interruptedSnapshot(phase)
      const callId = Object.keys(snapshot.values.run!.toolCallOutcomes!).find((id) => id.startsWith('timed:compact:'))!
      expect(callId).toBeDefined()
      expect(snapshot.values.run?.toolCallOutcomes?.[callId].state).toBe(phase === 'receipt' ? 'outcomeKnown' : 'outcomeUnknown')
      expect(Boolean(snapshot.values.conversation.contextCheckpoint)).toBe(phase !== 'summary')
      const { core, recovery, fetchImpl, id, store } = await restore(snapshot)

      expect(core.getSessionRecoveryStatus(id)).toMatchObject({ status: 'recoverable' })
      expect(store.getter(runAtom)?.toolCallOutcomes).toEqual(snapshot.values.run?.toolCallOutcomes)
      expect(core.continueRecoveredSession(id)).toMatchObject({ status: 'continued' })
      await vi.waitFor(() => expect(store.getter(runAtom)?.status).toBe('done'))

      expect(fetchImpl).toHaveBeenCalledTimes(phase === 'summary' ? 2 : 1)
      expect(store.getter(contextCheckpointAtom)?.summary).toBe(
        phase === 'summary' ? 'Resumed task and next action.' : 'Saved task and next action.',
      )
      expect(store.getter(itemsAtom)[0]).toEqual(snapshot.values.conversation.items[0])
      const durable = await recovery.loadLatest(id)
      expect(Object.values(durable!.values.run!.toolCallOutcomes ?? {}).every((fact) => fact.state === 'outcomeKnown')).toBe(true)
      const receipts = store.getter(itemsAtom).filter(({ item }) => item.role === 'tool' && item.tool_call_id === callId)
      expect(receipts).toHaveLength(phase === 'checkpoint' ? 0 : 1)
    },
  )

  it('retries a compaction whose execution fence failed before it started', async () => {
    const snapshot = await interruptedSnapshot('summary')
    const fact = Object.values(snapshot.values.run!.toolCallOutcomes!)[0]
    fact.state = 'notStarted'
    const { core, fetchImpl, id, store } = await restore(snapshot)

    expect(core.continueRecoveredSession(id)).toMatchObject({ status: 'continued' })
    await vi.waitFor(() => expect(store.getter(runAtom)?.status).toBe('done'))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['error', 'skipped', 'tombstoned', 'rejected'] as const)(
    'does not retry before compaction recovery is durably saved (%s)',
    async (failure) => {
      const { core, fetchImpl, id, store } = await restore(await interruptedSnapshot('summary'))
      const persist = vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async () => {
        if (failure === 'rejected') throw new Error('writer rejected')
        return failure === 'error' ? { status: failure, sessionId: id, error: new Error('disk unavailable') }
          : failure === 'skipped' ? { status: failure, sessionId: id, reason: 'reset' }
            : { status: failure, sessionId: id }
      })

      expect(core.continueRecoveredSession(id)).toMatchObject({ status: 'continued' })
      await vi.waitFor(() => expect(persist).toHaveBeenCalledWith(id, 'interrupted_context_compaction'))
      expect(store.getter(runAtom)?.status).toBe('interrupted')
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['compact', 'custom_compaction', 'outcomeUnknown', false],
    ['preCompact', 'compact_context', 'outcomeUnknown', false],
    ['postCompact', 'compact_context', 'outcomeUnknown', false],
    ['compact', 'compact_context', 'outcomeKnown', false],
    ['compact', 'compact_context', 'outcomeUnknown', true],
  ] as const)('keeps other effects and inconsistent receipts blocked (%s/%s/%s/%s)', async (timing, name, state, receipt) => {
    const snapshot = await interruptedSnapshot('summary')
    const run = snapshot.values.run!
    const callId = `timed:${timing}:${run.runId}:0:${name}`
    run.toolCallOutcomes = { [callId]: { state, updatedAt: 1 } }
    if (receipt) snapshot.values.conversation.items.push({
      id: 'inconsistent-receipt', createdAt: 1,
      item: { role: 'tool', tool_call_id: callId, content: '{}' },
    })
    const { core, fetchImpl, id } = await restore(snapshot)

    expect(core.continueRecoveredSession(id)).toMatchObject({ status: 'reconciliation_required' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
