import { describe, expect, it } from 'vitest'
import type { ToolCallOutcomeState } from '../state/core.type'
import { createMemoryRecoveryDriver } from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
import { recoverInterruptedToolCalls } from './interruptedToolCallRecovery'

const sessionId = 'interrupted-tools'
const callId = 'call-1'

function setup(state?: ToolCallOutcomeState, toolName = 'shell_macos') {
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
        tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: '{}' } }],
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

  it('settles an unknown outcome for a pure tool with a retryable receipt instead of blocking', async () => {
    const { core, recovery, store } = setup('outcomeUnknown', 'read_file')

    await expect(recoverInterruptedToolCalls(sessionId, core)).resolves.toBe('ready')

    expect(toolReceipts(core)).toHaveLength(1)
    // 收据必须与 not_started 可区分：模型要知道「没跑过」和「跑没跑过不知道、但可重取」不是一回事。
    expect(toolReceipts(core)[0]?.item).toMatchObject({
      role: 'tool',
      tool_call_id: callId,
      content: expect.stringContaining('"result":"unknown_pure_retryable"'),
    })
    expect(store.getter(runAtom)?.toolCallOutcomes?.[callId]?.state).toBe('outcomeKnown')
    await expect(recovery.loadLatest(sessionId)).resolves.toMatchObject({
      values: { run: { toolCallOutcomes: { [callId]: { state: 'outcomeKnown' } } } },
    })
  })

  it('still requires reconciliation when a pure tool reports a known outcome without its receipt', async () => {
    const { core } = setup('outcomeKnown', 'read_file')

    // 只读不能豁免「结果已知却没有收据」——那是 transcript 与事实不一致，与可重复性无关。
    await expect(recoverInterruptedToolCalls(sessionId, core)).resolves.toBe('reconciliation_required')
    expect(toolReceipts(core)).toHaveLength(0)
  })

  it.each([
    ['an unknown outcome of a tool with side effects', 'outcomeUnknown' as const],
    ['a known outcome without its receipt', 'outcomeKnown' as const],
    ['a missing outcome fact', undefined],
  ])('requires reconciliation for %s', async (_label, state) => {
    const { core, recovery } = setup(state)

    await expect(recoverInterruptedToolCalls(sessionId, core)).resolves.toBe('reconciliation_required')

    expect(toolReceipts(core)).toHaveLength(0)
    await expect(recovery.loadLatest(sessionId)).resolves.toBeUndefined()
  })
})
