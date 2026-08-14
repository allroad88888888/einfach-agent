import { describe, expect, it } from 'vitest'
import type { ToolCallOutcomeState } from '../state/core.type'
import { createMemoryRecoveryDriver } from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
import { recoverInterruptedToolCalls } from './interruptedToolCallRecovery'

const sessionId = 'interrupted-tools'
const callId = 'call-1'

function setup(state?: ToolCallOutcomeState) {
  const core = createCoreInstance()
  core.rootStore.setter(sessionsAtom, {
    [sessionId]: {
      id: sessionId,
      title: 'Interrupted tools',
      settings: { vendor: 'test', model: 'test-model' },
      createdAt: 1,
      updatedAt: 1,
    },
  })
  const recovery = createMemoryRecoveryDriver()
  core.persistence.configure({
    recovery,
    recoveryStore: (id) => id === sessionId ? core.getSessionStore(id).store : undefined,
  })
  const store = core.getSessionStore(sessionId).store
  store.setter(itemsAtom, [
    { id: 'user-1', createdAt: 1, item: { role: 'user', content: 'continue' } },
    {
      id: 'assistant-1',
      createdAt: 2,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: 'shell_macos', arguments: '{"command":"pwd"}' } }],
      },
    },
  ])
  store.setter(runAtom, {
    runId: 'run-1',
    status: 'interrupted',
    turnId: 'user-1',
    ...(state === undefined ? {} : { toolCallOutcomes: { [callId]: { state, updatedAt: 3 } } }),
  })
  return { core, recovery, store }
}

function toolReceipts(core: CoreInstance) {
  return core.getSessionStore(sessionId).store.getter(itemsAtom)
    .filter((entry) => entry.item.role === 'tool' && entry.item.tool_call_id === callId)
}

describe('recoverInterruptedToolCalls', () => {
  it('writes an exact not_started receipt without undefined planStageId and persists it before ready', async () => {
    const { core, recovery, store } = setup('notStarted')

    await expect(recoverInterruptedToolCalls(sessionId, core)).resolves.toBe('ready')

    expect(toolReceipts(core)).toHaveLength(1)
    expect(toolReceipts(core)[0]).not.toHaveProperty('planStageId')
    expect(toolReceipts(core)[0]?.item).toMatchObject({
      role: 'tool',
      tool_call_id: callId,
      content: expect.stringContaining('"result":"not_started"'),
    })
    expect(store.getter(runAtom)?.toolCallOutcomes?.[callId]?.state).toBe('outcomeKnown')
    const latest = await recovery.loadLatest(sessionId)
    expect(latest).toMatchObject({
      values: {
        conversation: { items: expect.arrayContaining([expect.objectContaining({ item: expect.objectContaining({ tool_call_id: callId }) })]) },
        run: { toolCallOutcomes: { [callId]: { state: 'outcomeKnown' } } },
      },
    })
    expect(latest?.values.conversation.items).toHaveLength(3)
    expect(latest?.values.conversation.items.every((entry) => !Object.hasOwn(entry, 'planStageId'))).toBe(true)
  })

  it.each([
    ['an unknown outcome', 'outcomeUnknown' as const],
    ['a known outcome without its receipt', 'outcomeKnown' as const],
    ['a missing outcome fact', undefined],
  ])('requires reconciliation for %s', async (_label, state) => {
    const { core, recovery } = setup(state)

    await expect(recoverInterruptedToolCalls(sessionId, core)).resolves.toBe('reconciliation_required')

    expect(toolReceipts(core)).toHaveLength(0)
    await expect(recovery.loadLatest(sessionId)).resolves.toBeUndefined()
  })
})
