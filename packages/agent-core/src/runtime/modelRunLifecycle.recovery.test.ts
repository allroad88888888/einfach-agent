// 模型启动/恢复的显式 recovery 边界。

import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../state/core.type'
import { createMemoryRecoveryDriver } from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootStore'
import { itemsAtom, planAtom, runAtom } from '../state/sessionAtoms'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
import {
  continueInterruptedModelRun,
  continuePlanModelRun,
  startModelRun,
  type ModelRunOptions,
  type ToolLoopRunner,
} from './modelRunLifecycle'
import { resumeInterruptedSession } from './runToolLoop'

const SESSION_ID = 'recovery-model-session'

function setup(): { core: CoreInstance; recovery: ReturnType<typeof createMemoryRecoveryDriver> } {
  const core = createCoreInstance()
  const session: SessionMeta = {
    id: SESSION_ID,
    title: 'Interrupted task',
    settings: { vendor: 'deepseek', model: 'test-model' },
    createdAt: 1,
    updatedAt: 1,
  }
  core.rootStore.setter(sessionsAtom, { [SESSION_ID]: session })
  const recovery = createMemoryRecoveryDriver()
  core.persistence.configure({
    recovery,
    recoveryStore: (id) => id === SESSION_ID ? core.getSessionStore(id).store : undefined,
  })
  return { core, recovery }
}

function options(core: CoreInstance): ModelRunOptions {
  return { core, apiKey: 'test-key', signal: new AbortController().signal }
}

async function latest(core: CoreInstance, recovery: ReturnType<typeof createMemoryRecoveryDriver>) {
  await core.persistence.flushRecovery()
  return recovery.loadLatest(SESSION_ID)
}

describe('modelRunLifecycle recovery boundaries', () => {
  it('captures the persisted user item and running state before the first model loop', async () => {
    const { core, recovery } = setup()
    let loopSnapshot: Awaited<ReturnType<typeof latest>>
    const runLoop: ToolLoopRunner = async () => {
      loopSnapshot = await latest(core, recovery)
    }

    await startModelRun(SESSION_ID, 'continue this task', options(core), runLoop)

    expect(loopSnapshot!).toMatchObject({
      session: { id: SESSION_ID, title: 'Interrupted task' },
      values: {
        conversation: { items: [{ item: { role: 'user', content: 'continue this task' } }] },
        run: { status: 'running' },
      },
    })
  })

  it('does not start a model loop when the recovery write fails', async () => {
    const { core } = setup()
    core.persistence.configure({
      recovery: {
        listLatest: async () => [],
        loadLatest: async () => undefined,
        saveLatest: async () => { throw new Error('disk unavailable') },
        deleteSession: async () => {},
      },
      recoveryStore: (id) => id === SESSION_ID ? core.getSessionStore(id).store : undefined,
    })
    let started = false

    await startModelRun(SESSION_ID, 'do not start', options(core), async () => { started = true })

    expect(started).toBe(false)
    expect(core.getSessionStore(SESSION_ID).store.getter(runAtom)).toMatchObject({
      status: 'interrupted',
      error: 'Recovery persistence failed before model execution.',
    })
  })

  it('captures interrupted and plan transitions before their fresh model loops', async () => {
    const { core, recovery } = setup()
    const store = core.getSessionStore(SESSION_ID).store
    store.setter(itemsAtom, [{ id: 'user-1', createdAt: 1, item: { role: 'user', content: 'saved transcript' } }])
    store.setter(runAtom, { runId: 'interrupted-run', status: 'interrupted', turnId: 'user-1', startedAt: 1 })

    let interruptedSnapshot: Awaited<ReturnType<typeof latest>>
    await continueInterruptedModelRun(SESSION_ID, options(core), async () => {
      interruptedSnapshot = await latest(core, recovery)
    })

    expect(interruptedSnapshot!.values).toMatchObject({
      conversation: { items: [{ item: { content: 'saved transcript' } }] },
      run: { runId: 'interrupted-run', status: 'running', turnId: 'user-1' },
    })

    let planSnapshot: Awaited<ReturnType<typeof latest>>
    await continuePlanModelRun(SESSION_ID, options(core), async () => {
      planSnapshot = await latest(core, recovery)
    })

    expect(planSnapshot!.values.run).toMatchObject({ status: 'running', turnId: 'user-1' })
  })

  it('does not start a model loop when an interrupted tool call has an unknown outcome', async () => {
    const { core } = setup()
    const store = core.getSessionStore(SESSION_ID).store
    store.setter(itemsAtom, [
      { id: 'user-1', createdAt: 1, item: { role: 'user', content: 'saved transcript' } },
      {
        id: 'assistant-1',
        createdAt: 2,
        planStageId: 'stage-1',
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'shell_macos', arguments: '{}' } }],
        },
      },
    ])
    store.setter(runAtom, {
      runId: 'interrupted-run',
      status: 'interrupted',
      turnId: 'user-1',
      startedAt: 1,
      toolCallOutcomes: { 'tool-1': { state: 'outcomeUnknown', updatedAt: 2 } },
    })
    let started = false

    await continueInterruptedModelRun(SESSION_ID, options(core), async () => { started = true })

    expect(started).toBe(false)
    expect(store.getter(runAtom)?.status).toBe('interrupted')
  })

  it('does not erase an unknown tool outcome when resuming a stopped plan', async () => {
    const { core } = setup()
    const store = core.getSessionStore(SESSION_ID).store
    store.setter(planAtom, {
      schemaVersion: 4,
      id: 'plan-1',
      title: 'Active plan',
      objective: 'Resume safely',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: 1,
      updatedAt: 1,
      stages: [{
        id: 'stage-1',
        title: 'Continue',
        objective: 'Continue safely',
        deliverables: [],
        dependencies: [],
        status: 'in_progress',
        evidence: [],
      }],
    })
    store.setter(itemsAtom, [
      { id: 'user-1', createdAt: 1, item: { role: 'user', content: 'saved transcript' } },
      {
        id: 'assistant-1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'shell_macos', arguments: '{}' } }],
        },
      },
    ])
    store.setter(runAtom, {
      runId: 'stopped-plan-run',
      status: 'stopped',
      turnId: 'user-1',
      toolCallOutcomes: { 'tool-1': { state: 'outcomeUnknown', updatedAt: 2 } },
    })
    let started = false

    await continuePlanModelRun(SESSION_ID, options(core), async () => { started = true })

    expect(started).toBe(false)
    expect(store.getter(runAtom)).toMatchObject({
      runId: 'stopped-plan-run',
      status: 'stopped',
      toolCallOutcomes: { 'tool-1': { state: 'outcomeUnknown' } },
    })
  })

  it('records an unstarted interrupted tool call before starting its fresh model loop', async () => {
    const { core, recovery } = setup()
    const store = core.getSessionStore(SESSION_ID).store
    store.setter(itemsAtom, [
      { id: 'user-1', createdAt: 1, item: { role: 'user', content: 'saved transcript' } },
      {
        id: 'assistant-1',
        createdAt: 2,
        planStageId: 'stage-1',
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'shell_macos', arguments: '{}' } }],
        },
      },
    ])
    store.setter(runAtom, {
      runId: 'interrupted-run',
      status: 'interrupted',
      turnId: 'user-1',
      startedAt: 1,
      toolCallOutcomes: { 'tool-1': { state: 'notStarted', updatedAt: 2 } },
    })
    let loopSnapshot: Awaited<ReturnType<typeof latest>>

    await continueInterruptedModelRun(SESSION_ID, options(core), async () => {
      loopSnapshot = await recovery.loadLatest(SESSION_ID)
    })

    expect(loopSnapshot!.values.conversation.items).toContainEqual(expect.objectContaining({
      item: expect.objectContaining({ role: 'tool', tool_call_id: 'tool-1' }),
    }))
    expect(loopSnapshot!.values.run?.toolCallOutcomes).toMatchObject({
      'tool-1': { state: 'outcomeKnown' },
    })
    expect(loopSnapshot!.values.run?.status).toBe('running')
    expect(store.getter(runAtom)?.status).toBe('running')
  })

  it('starts one new request from the persisted transcript, never an old stream', async () => {
    const { core } = setup()
    const store = core.getSessionStore(SESSION_ID).store
    store.setter(itemsAtom, [{ id: 'user-1', createdAt: 1, item: { role: 'user', content: 'persisted prompt' } }])
    store.setter(runAtom, { runId: 'interrupted-run', status: 'interrupted', turnId: 'user-1', startedAt: 1 })
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = []

    await resumeInterruptedSession(SESSION_ID, {
      ...options(core),
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> })
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fresh reply' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'persisted prompt' }))
  })
})
