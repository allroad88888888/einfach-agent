import { createStore } from '@einfach/core'
import { compactContextTool } from '@einfach-agent/tools-agents'
import { describe, expect, it, vi } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import { contextCheckpointAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { createLockedEmptySessionCapabilityPolicy } from '../state/sessionCapabilityPolicy'
import { applyRecoverySnapshot, captureRecoverySnapshot } from '../state/recoveryProjection'
import { createCoreInstance } from './core/coreInstance'
import { runToolLoop } from './runToolLoop'
import { jsonResponse } from './modelRun.testHarness'

function fixture(registered = true) {
  const id = 'compact-session'
  const core = createCoreInstance({ registerTools: (tools) => {
    if (registered) tools.register(compactContextTool)
  } })
  core.rootStore.setter(sessionsAtom, { [id]: {
    id, title: 'compression', settings: { vendor: 'deepseek', model: 'x', max_tokens: 48_000 },
    capabilityPolicy: createLockedEmptySessionCapabilityPolicy(), createdAt: 1, updatedAt: 1,
  } })
  const session = core.getSessionStore(id)
  const original = [{ id: 'user-1', createdAt: 1, item: { role: 'user' as const, content: 'x'.repeat(60_000) } }]
  session.store.setter(itemsAtom, original)
  setRun(id, { runId: 'run-1', turnId: 'user-1', status: 'running' }, core)
  const controller = new AbortController()
  return {
    id, core, session, original, controller,
    run: (fetchImpl: typeof fetch) => runToolLoop(id, 'run-1', {
      core, apiKey: 'test', signal: controller.signal, fetchImpl,
    }),
  }
}

describe('main compaction tool state integration', () => {
  it('works in a locked conversation and reuses undo/redo and recovery without rewriting history', async () => {
    const { run, core, id, session, original } = fixture()
    const fetchImpl = vi.fn(async () => jsonResponse('Preserved task and next action.'))
    await run(fetchImpl)
    const summary = session.store.getter(contextCheckpointAtom)
    expect(summary?.summary).toBe('Preserved task and next action.')
    expect(session.store.getter(itemsAtom)[0]).toBe(original[0])
    expect(session.store.getter(runAtom)?.status).toBe('done')
    expect(core.tools.loadSchema('compact_context')).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const snapshot = captureRecoverySnapshot(session.store, {
      rootStore: core.rootStore, sessionId: id, generation: 1,
    })
    const restored = createStore()
    applyRecoverySnapshot(restored, snapshot)
    expect(restored.getter(contextCheckpointAtom)).toEqual(summary)

    const entries = session.history.getState().entries
    const summaryIndex = entries.findIndex((entry) => entry.ops.some((op) => op.key === 'contextCheckpoint'))
    expect(summaryIndex).toBeGreaterThanOrEqual(0)
    while (session.history.getState().cursor > summaryIndex) expect(session.history.undo()).toBe(true)
    expect(session.store.getter(contextCheckpointAtom)).toBeUndefined()
    expect(session.store.getter(itemsAtom)).toEqual(original)
    expect(session.history.redo()).toBe(true)
    expect(session.store.getter(contextCheckpointAtom)).toEqual(summary)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['', 's'.repeat(90_000)])('does not commit an empty or oversized summary (%#)', async (summary) => {
    const { run, session, original } = fixture()
    const fetchImpl = vi.fn(async () => jsonResponse(summary))
    await run(fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(session.store.getter(contextCheckpointAtom)).toBeUndefined()
    expect(session.store.getter(itemsAtom)[0]).toBe(original[0])
    expect(session.store.getter(runAtom)?.status).toBe('error')
  })

  it('reports a missing compression tool before making a model request', async () => {
    const { run, session } = fixture(false)
    const fetchImpl = vi.fn(async () => jsonResponse('unused'))
    await run(fetchImpl)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(session.store.getter(runAtom)).toMatchObject({ status: 'error', error: expect.stringContaining('compact') })
  })

  it('rejects a late summary after cancellation', async () => {
    const { run, session, controller } = fixture()
    await run(async () => {
      controller.abort()
      return jsonResponse('late summary')
    })
    expect(session.store.getter(contextCheckpointAtom)).toBeUndefined()
  })

  it('rejects a summary whose source changed while the model was running', async () => {
    const { run, session } = fixture()
    await run(async () => {
      session.store.setter(itemsAtom, [{ id: 'replacement', createdAt: 2, item: { role: 'user', content: 'new history' } }])
      return jsonResponse('obsolete summary')
    })
    expect(session.store.getter(contextCheckpointAtom)).toBeUndefined()
    expect(session.store.getter(itemsAtom)[0].id).toBe('replacement')
    expect(session.store.getter(runAtom)?.status).toBe('error')
  })
})
