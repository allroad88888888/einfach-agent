import { describe, expect, it, vi } from 'vitest'
import type { PlanSnapshot, PlanStatus } from '../planning/types'
import type { SessionMeta } from '../state/core.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../state/persistence/recoveryDriver'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom, planAtom, runAtom } from '../state/sessionAtoms'
import { pendingQuestionAnswersAtom, queuedUserMessagesAtom } from '../state/transientAtoms'
import type { CoreInstance } from './core/coreInstance'
import { createCore } from './core/createCore'

function emptySessionsDriver(): SessionsPersistence {
  return {
    loadSessions: async () => [],
    saveSessions: async () => {},
    loadWorkspaces: async () => [],
    saveWorkspaces: async () => {},
  }
}

function sessionMeta(id: string): SessionMeta {
  return {
    id,
    title: `Recovery ${id}`,
    settings: { vendor: 'deepseek', model: 'recovery-test' },
    createdAt: 1,
    updatedAt: 1,
  }
}

function configureRecovery(core: CoreInstance, recovery: RecoveryDriver): void {
  core.persistence.configure({
    sessions: emptySessionsDriver(),
    recovery,
    recoveryStore: (id) => core.findSessionStore(id)?.store,
  })
}

function addSession(core: CoreInstance, id: string): void {
  core.rootStore.setter(sessionsAtom, { [id]: sessionMeta(id) })
}

async function persistThenHydrate(
  coreA: CoreInstance,
  coreB: CoreInstance,
  recovery: RecoveryDriver,
  id: string,
): Promise<number> {
  configureRecovery(coreA, recovery)
  configureRecovery(coreB, recovery)
  const saved = await coreA.persistence.persistRecovery(id, 'integration_seed')
  expect(saved).toMatchObject({ status: 'saved' })
  await coreA.persistence.flushRecovery()
  const snapshot = await recovery.loadLatest(id)
  expect(snapshot).toBeDefined()
  await expect(coreB.persistence.hydrate()).resolves.toBe(true)
  return snapshot!.generation
}

function plan(status: Extract<PlanStatus, 'approved' | 'active' | 'awaiting_approval'>): PlanSnapshot {
  return {
    schemaVersion: 4,
    id: 'recovery-plan',
    title: 'Recover a plan',
    objective: 'Resume only its persisted stage',
    status,
    revision: 1,
    requiresApproval: status === 'awaiting_approval',
    createdAt: 1,
    updatedAt: 1,
    stages: [{
      id: 'stage-1',
      title: 'Persisted stage',
      objective: 'Continue this stage',
      deliverables: [],
      dependencies: [],
      status: status === 'awaiting_approval' ? 'pending' : 'in_progress',
      evidence: [],
    }],
  }
}

function modelResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestContents(body: Record<string, unknown> | undefined): unknown[] {
  if (!Array.isArray(body?.messages)) return []
  return body.messages.map((message) => (
    typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined
  ))
}

describe('recovery pause and plan continuity across Core instances', () => {
  it('hydrates transcript, queued user messages, and pending answers exactly', async () => {
    const id = 'paused-payload'
    const recovery = createMemoryRecoveryDriver()
    const coreA = createCore()
    const coreB = createCore()
    addSession(coreA, id)
    const source = coreA.getSessionStore(id).store
    const transcript = [
      { id: 'user-1', createdAt: 1, item: { role: 'user' as const, content: 'Keep every pause value' } },
      { id: 'assistant-1', createdAt: 2, item: { role: 'assistant' as const, content: 'I need an answer first.' } },
    ]
    const queued = [{ id: 'queued-1', createdAt: 3, content: 'Queued while paused', targetRunId: 'waiting-run' }]
    const answers = { 'question-1': ['first answer', 'second answer'] }
    source.setter(itemsAtom, transcript)
    source.setter(queuedUserMessagesAtom, queued)
    source.setter(pendingQuestionAnswersAtom, answers)
    source.setter(runAtom, {
      runId: 'waiting-run',
      status: 'waiting_user',
      pendingQuestion: { question: 'Which answer should I use?' },
    })

    await persistThenHydrate(coreA, coreB, recovery, id)

    const restored = coreB.getSessionStore(id).store
    expect(restored.getter(itemsAtom)).toEqual(transcript)
    expect(restored.getter(queuedUserMessagesAtom)).toEqual(queued)
    expect(restored.getter(pendingQuestionAnswersAtom)).toEqual(answers)
    expect(restored.getter(runAtom)).toEqual({
      runId: 'waiting-run',
      status: 'waiting_user',
      pendingQuestion: { question: 'Which answer should I use?' },
    })
  })

  it('keeps a waiting user pause awaiting without a model request', async () => {
    const id = 'waiting-user'
    const recovery = createMemoryRecoveryDriver()
    let requests = 0
    const coreA = createCore()
    const coreB = createCore({
      config: { modelCredentials: { deepseek: 'test-key' }, fetchImpl: async () => {
        requests += 1
        return modelResponse('unexpected request')
      } },
    })
    addSession(coreA, id)
    coreA.getSessionStore(id).store.setter(runAtom, { runId: 'waiting-run', status: 'waiting_user' })

    await persistThenHydrate(coreA, coreB, recovery, id)

    expect(coreB.continueRecoveredSession(id)).toEqual({
      status: 'awaiting_user', sessionId: id, waitingFor: 'waiting_user',
    })
    await Promise.resolve()
    expect(requests).toBe(0)
  })

  it('keeps a plan approval pause awaiting without a model request', async () => {
    const id = 'waiting-plan-approval'
    const recovery = createMemoryRecoveryDriver()
    let requests = 0
    const coreA = createCore()
    const coreB = createCore({
      config: { modelCredentials: { deepseek: 'test-key' }, fetchImpl: async () => {
        requests += 1
        return modelResponse('unexpected request')
      } },
    })
    addSession(coreA, id)
    coreA.getSessionStore(id).store.setter(planAtom, plan('awaiting_approval'))

    await persistThenHydrate(coreA, coreB, recovery, id)

    expect(coreB.continueRecoveredSession(id)).toEqual({
      status: 'awaiting_user', sessionId: id, waitingFor: 'plan_approval',
    })
    await Promise.resolve()
    expect(requests).toBe(0)
  })

  it.each(['approved', 'active'] as const)(
    'continues a recovered %s plan through the plan-resume boundary after a newer recovery generation',
    async (status) => {
      const id = `recover-${status}-plan`
      const recovery = createMemoryRecoveryDriver()
      let requests = 0
      let firstRequest: Record<string, unknown> | undefined
      let snapshotAtFirstRequest: Awaited<ReturnType<RecoveryDriver['loadLatest']>>
      const coreA = createCore()
      const coreB = createCore({
        config: {
          modelCredentials: { deepseek: 'test-key' },
          fetchImpl: async (_url, init) => {
            requests += 1
            firstRequest ??= JSON.parse(String(init?.body)) as Record<string, unknown>
            snapshotAtFirstRequest ??= await recovery.loadLatest(id)
            coreB.getSessionStore(id).store.setter(planAtom, (current) => current === undefined
              ? current
              : { ...current, status: 'completed', stages: current.stages.map((stage) => ({ ...stage, status: 'completed' })) })
            return modelResponse('Recovered plan completed')
          },
        },
      })
      addSession(coreA, id)
      const source = coreA.getSessionStore(id).store
      source.setter(itemsAtom, [{
        id: 'persisted-user', createdAt: 1, item: { role: 'user', content: 'Resume the approved work' },
      }])
      source.setter(planAtom, plan(status))

      const persistedGeneration = await persistThenHydrate(coreA, coreB, recovery, id)

      expect(coreB.continueRecoveredSession(id)).toEqual({ status: 'continued', sessionId: id, continuation: 'plan' })
      await vi.waitFor(() => expect(requests).toBe(1))
      expect(snapshotAtFirstRequest?.generation).toBeGreaterThan(persistedGeneration)
      expect(snapshotAtFirstRequest?.values.run).toMatchObject({ status: 'running' })
      expect(requestContents(firstRequest)).toContain(
        '这是一次从持久化状态恢复的计划执行，不是新的用户请求。\n沿用 current_plan_definition / current_plan_state 中的计划、revision 与当前阶段；不要重新创建计划。\n从尚未完成的阶段继续，完成阶段产出后调用 submit_stage_result，并继续后续阶段直到计划结束。',
      )
      await vi.waitFor(() => expect(coreB.getSessionStore(id).store.getter(runAtom)?.status).toBe('done'))
      expect(requests).toBe(1)
    },
  )
})
