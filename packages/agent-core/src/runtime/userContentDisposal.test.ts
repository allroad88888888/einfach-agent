import { describe, expect, it, vi } from 'vitest'
import type { UserMessageContent } from '@web-agent/ai'
import { checkpointsAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { queuedUserMessagesAtom } from '../state/sessionTransientAtoms'
import { sessionsAtom } from '../state/rootAtoms'
import type { ConversationItem } from '../state/core.type'
import type { QueuedUserMessage } from '../state/sessionTransientPayloads'
import { createCore } from './core/createCore'

function imageContent(reference: string, text: string): UserMessageContent {
  return [
    { type: 'text', text },
    {
      type: 'image',
      source: {
        kind: 'provider-file',
        provider: 'kimi',
        scope: 'scope-private',
        reference,
      },
      name: `${text}.png`,
      mimeType: 'image/png',
      byteSize: 12,
    },
  ]
}

function user(id: string, content: UserMessageContent, createdAt: number): ConversationItem {
  return { id, createdAt, item: { role: 'user', content } }
}

function queued(
  id: string,
  content: UserMessageContent,
  targetRunId: string,
): QueuedUserMessage {
  return { id, createdAt: 20, content, targetRunId }
}

function setup(disposeUserContent = vi.fn()) {
  const core = createCore({ config: { disposeUserContent } })
  const id = core.newSession({
    title: 'structured',
    settings: { vendor: 'kimi', model: 'kimi-k2.6', region: 'cn', thinking: true },
  })
  return { core, id, store: core.getSessionStore(id).store, disposeUserContent }
}

describe('provider-neutral user content disposal', () => {
  it('removes a session locally even when unique content cleanup throws or rejects', async () => {
    const failures = [
      () => { throw new Error('sync cleanup failed') },
      () => Promise.reject(new Error('async cleanup failed')),
    ]
    for (const fail of failures) {
      const dispose = vi.fn(fail)
      const { core, id, store } = setup(dispose)
      const first = imageContent('ref-first', 'first')
      const second = imageContent('ref-second', 'second')
      store.setter(itemsAtom, [user('u1', first, 1)])
      store.setter(checkpointsAtom, [{
        turnIndex: 0,
        label: 'first',
        createdAt: 2,
        items: [user('u1-copy', first, 1)],
      }])
      store.setter(queuedUserMessagesAtom, [queued('q1', second, 'run-1')])

      expect(() => core.removeSession(id)).not.toThrow()
      await Promise.resolve()

      expect(core.rootStore.getter(sessionsAtom)[id]).toBeUndefined()
      expect(dispose).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledWith([first, second], [], {
        sessionId: id,
        reason: 'session_removed',
        settings: { vendor: 'kimi', model: 'kimi-k2.6', region: 'cn', thinking: true },
      })
    }
  })

  it('passes globally retained content so hosts can protect a shared provider reference', () => {
    const { core, id, store, disposeUserContent } = setup()
    const discarded = imageContent('shared-ref', 'discarded label')
    store.setter(itemsAtom, [user('u1', discarded, 1)])
    const retainedId = core.newSession({
      title: 'retained',
      settings: { vendor: 'kimi', model: 'kimi-k2.6', region: 'cn', thinking: true },
    })
    const retained = imageContent('shared-ref', 'different retained label')
    core.getSessionStore(retainedId).store.setter(itemsAtom, [user('u2', retained, 2)])

    core.removeSession(id)

    expect(disposeUserContent).toHaveBeenCalledWith(
      [discarded],
      [retained],
      expect.objectContaining({ sessionId: id, reason: 'session_removed' }),
    )
  })

  it('revertToTurn disposes only content lost from history and all abandoned queues', () => {
    const { core, id, store, disposeUserContent } = setup()
    const persistTruncate = vi.spyOn(core.persistence, 'persistTruncate')
    const retained = imageContent('ref-retained', 'retained')
    const discarded = imageContent('ref-discarded', 'discarded')
    const queuedOnly = imageContent('ref-queued', 'queued')
    const firstTurn = [user('u0', retained, 1)]
    const secondTurn = [...firstTurn, user('u1', discarded, 2)]
    store.setter(itemsAtom, secondTurn)
    store.setter(checkpointsAtom, [
      {
        turnIndex: 0,
        label: '[执行中] first',
        createdAt: 1,
        items: firstTurn,
        kind: 'working',
        recovery: {
          run: { runId: 'obsolete', status: 'running', turnId: 'u0' },
          queuedUserMessages: [queued('q1', queuedOnly, 'obsolete')],
        },
      },
      { turnIndex: 1, label: 'second', createdAt: 2, items: secondTurn },
    ])
    store.setter(runAtom, { runId: 'obsolete', status: 'running', turnId: 'u0' })
    store.setter(queuedUserMessagesAtom, [queued('q1', queuedOnly, 'obsolete')])

    core.revertToTurn(0)

    expect(store.getter(itemsAtom)).toEqual(firstTurn)
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(store.getter(checkpointsAtom)[0]).toMatchObject({ kind: 'stopped' })
    expect(store.getter(checkpointsAtom)[0].recovery).toBeUndefined()
    expect(persistTruncate).toHaveBeenCalledWith(id, 0)
    expect(disposeUserContent).toHaveBeenCalledOnce()
    expect(disposeUserContent).toHaveBeenCalledWith(
      [discarded, queuedOnly],
      [retained],
      expect.objectContaining({ sessionId: id, reason: 'history_truncated' }),
    )
  })

  it('revertTurnToDraft releases the edited turn and its mismatched queue', () => {
    const { core, id, store, disposeUserContent } = setup()
    const retained = imageContent('ref-before', 'before')
    const edited = imageContent('ref-edit', 'edit this')
    const abandoned = imageContent('ref-abandoned', 'abandoned')
    const firstTurn = [user('u0', retained, 1)]
    const secondTurn = [...firstTurn, user('u1', edited, 10)]
    store.setter(itemsAtom, secondTurn)
    store.setter(checkpointsAtom, [
      { turnIndex: 0, label: 'before', createdAt: 2, items: firstTurn },
      { turnIndex: 1, label: 'edit', createdAt: 11, items: secondTurn },
    ])
    store.setter(runAtom, { runId: 'done-run', status: 'done' })
    store.setter(queuedUserMessagesAtom, [queued('q1', abandoned, 'old-run')])

    core.revertTurnToDraft(1)

    expect(store.getter(itemsAtom)).toEqual(firstTurn)
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(disposeUserContent).toHaveBeenCalledOnce()
    expect(disposeUserContent).toHaveBeenCalledWith(
      [edited, abandoned],
      [retained],
      expect.objectContaining({ reason: 'history_truncated' }),
    )
  })

  it('withdraw delegates checkpoint cleanup once and clears the checkpoint run queue', () => {
    const { core, store, disposeUserContent } = setup()
    const retained = imageContent('ref-old', 'old')
    const withdrawn = imageContent('ref-withdrawn', 'withdrawn')
    const queueContent = imageContent('ref-queue', 'queue')
    const firstTurn = [user('u0', retained, 1)]
    const stoppedTurn = [...firstTurn, user('u1', withdrawn, 10)]
    store.setter(itemsAtom, stoppedTurn)
    store.setter(checkpointsAtom, [
      { turnIndex: 0, label: 'old', createdAt: 2, items: firstTurn },
      { turnIndex: 1, label: 'stopped', createdAt: 11, items: stoppedTurn },
    ])
    store.setter(runAtom, { runId: 'stopped-run', status: 'stopped' })
    store.setter(queuedUserMessagesAtom, [queued('q1', queueContent, 'stopped-run')])

    core.withdrawCurrentTurnToDraft()

    expect(store.getter(itemsAtom)).toEqual(firstTurn)
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(disposeUserContent).toHaveBeenCalledOnce()
    expect(disposeUserContent).toHaveBeenCalledWith(
      [withdrawn, queueContent],
      [retained],
      expect.objectContaining({ reason: 'history_truncated' }),
    )
  })

  it('stopRun drops every now-ownerless queue and prevents working recovery resurrection', () => {
    const { core, id, store, disposeUserContent } = setup()
    const retained = imageContent('ref-live', 'live')
    const stoppedQueue = queued('q-stop', imageContent('ref-stop', 'stop'), 'run-1')
    const otherQueue = queued('q-other', imageContent('ref-other', 'other'), 'run-2')
    const liveItems = [user('u0', retained, 1)]
    store.setter(itemsAtom, liveItems)
    store.setter(runAtom, { runId: 'run-1', status: 'running', turnId: 'u0' })
    store.setter(queuedUserMessagesAtom, [stoppedQueue, otherQueue])
    store.setter(checkpointsAtom, [{
      turnIndex: 0,
      label: 'working',
      createdAt: 2,
      items: liveItems,
      kind: 'working',
      recovery: {
        run: { runId: 'run-1', status: 'running', turnId: 'u0' },
        queuedUserMessages: [stoppedQueue, otherQueue],
      },
    }])
    const persistCheckpoint = vi.spyOn(core.persistence, 'persistCheckpoint')

    core.stopRun()

    expect(store.getter(runAtom)).toMatchObject({ runId: 'run-1', status: 'stopped' })
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(store.getter(checkpointsAtom)[0]).toMatchObject({ kind: 'stopped' })
    expect(store.getter(checkpointsAtom)[0].recovery).toBeUndefined()
    expect(persistCheckpoint).toHaveBeenCalledOnce()
    expect(persistCheckpoint).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ kind: 'stopped', recovery: undefined }),
    )
    expect(disposeUserContent).toHaveBeenCalledOnce()
    expect(disposeUserContent).toHaveBeenCalledWith(
      [stoppedQueue.content, otherQueue.content],
      [retained],
      expect.objectContaining({ sessionId: id, reason: 'run_stopped' }),
    )
  })

  it('stopRun also finalizes a paused run with recoverable queued content', () => {
    const { core, id, store, disposeUserContent } = setup()
    const pausedQueue = queued('q-paused', imageContent('ref-paused', 'paused'), 'run-paused')
    store.setter(runAtom, { runId: 'run-paused', status: 'waiting_confirmation' })
    store.setter(queuedUserMessagesAtom, [pausedQueue])
    store.setter(checkpointsAtom, [{
      turnIndex: 0,
      label: '[执行中] paused',
      createdAt: 2,
      items: [],
      kind: 'working',
      recovery: {
        run: { runId: 'run-paused', status: 'waiting_confirmation' },
        queuedUserMessages: [pausedQueue],
      },
    }])

    core.stopRun()

    expect(store.getter(runAtom)).toMatchObject({ runId: 'run-paused', status: 'stopped' })
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(store.getter(checkpointsAtom)[0]).toMatchObject({ kind: 'stopped', recovery: undefined })
    expect(disposeUserContent).toHaveBeenCalledWith(
      [pausedQueue.content],
      [],
      expect.objectContaining({ sessionId: id, reason: 'run_stopped' }),
    )
  })
})
