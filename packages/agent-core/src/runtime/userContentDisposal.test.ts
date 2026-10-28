import { describe, expect, it, vi } from 'vitest'
import type { UserMessageContent } from '@einfach-agent/ai'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { queuedUserMessagesAtom } from '../state/sessionTransientAtoms'
import { sessionsAtom } from '../state/rootAtoms'
import type { ConversationItem } from '../state/core.type'
import type { QueuedUserMessage } from '../state/sessionTransientPayloads'
import { createCore } from './core/createCore'
import { appendItem } from '../state/sessionWriters'

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
    settings: { vendor: 'kimi', model: 'kimi-k3', vendorSettings: { region: 'cn' }, thinking: true },
  })
  return { core, id, store: core.getSessionStore(id).store, disposeUserContent }
}

describe('provider-neutral user content disposal', () => {
  it('releases content when a new branch permanently drops its redo tail', () => {
    const { core, id, disposeUserContent } = setup()
    const abandoned = imageContent('ref-abandoned', 'abandoned')
    appendItem(id, user('u1', abandoned, 1), core)
    expect(core.undoEntry()).toMatchObject({ ok: true })

    appendItem(id, user('u2', 'replacement', 2), core)

    expect(disposeUserContent).toHaveBeenCalledWith(
      [abandoned],
      ['replacement'],
      expect.objectContaining({ sessionId: id, reason: 'history_truncated' }),
    )
  })

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
      store.setter(queuedUserMessagesAtom, [queued('q1', second, 'run-1')])

      expect(() => core.removeSession(id)).not.toThrow()
      await Promise.resolve()

      expect(core.rootStore.getter(sessionsAtom)[id]).toBeUndefined()
      expect(dispose).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledWith([first, second], [], {
        sessionId: id,
        reason: 'session_removed',
        settings: { vendor: 'kimi', model: 'kimi-k3', vendorSettings: { region: 'cn' }, thinking: true },
      })
    }
  })

  it('passes globally retained content so hosts can protect a shared provider reference', () => {
    const { core, id, store, disposeUserContent } = setup()
    const discarded = imageContent('shared-ref', 'discarded label')
    store.setter(itemsAtom, [user('u1', discarded, 1)])
    const retainedId = core.newSession({
      title: 'retained',
      settings: { vendor: 'kimi', model: 'kimi-k3', vendorSettings: { region: 'cn' }, thinking: true },
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

  it('stopRun keeps queue content while undo history can restore it', () => {
    const { core, id, store, disposeUserContent } = setup()
    const retained = imageContent('ref-live', 'live')
    const stoppedQueue = queued('q-stop', imageContent('ref-stop', 'stop'), 'run-1')
    const otherQueue = queued('q-other', imageContent('ref-other', 'other'), 'run-2')
    const liveItems = [user('u0', retained, 1)]
    store.setter(itemsAtom, liveItems)
    store.setter(runAtom, { runId: 'run-1', status: 'running', turnId: 'u0' })
    store.setter(queuedUserMessagesAtom, [stoppedQueue, otherQueue])

    core.stopRun()

    expect(store.getter(runAtom)).toMatchObject({ runId: 'run-1', status: 'stopped' })
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(disposeUserContent).not.toHaveBeenCalled()
    expect(core.undoTurn()).toMatchObject({ ok: true })
    expect(store.getter(queuedUserMessagesAtom)).toEqual([stoppedQueue, otherQueue])
  })

  it('stopRun also finalizes a paused run with recoverable queued content', () => {
    const { core, id, store, disposeUserContent } = setup()
    const pausedQueue = queued('q-paused', imageContent('ref-paused', 'paused'), 'run-paused')
    store.setter(runAtom, { runId: 'run-paused', status: 'waiting_confirmation' })
    store.setter(queuedUserMessagesAtom, [pausedQueue])

    core.stopRun()

    expect(store.getter(runAtom)).toMatchObject({ runId: 'run-paused', status: 'stopped' })
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(disposeUserContent).not.toHaveBeenCalled()
  })
})
