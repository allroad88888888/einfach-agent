import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserMessageContent } from '@web-agent/ai'

vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
}))

import { createCore } from './core/createCore'
import { runSession } from './modelRun'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import { queuedUserMessagesAtom } from '../state/transientAtoms'
import type {
  PreparedUserInput,
  UserInputPreparer,
  UserInputSubmission,
} from './userInputPreparation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

function prepared(reference: string, text: string): UserMessageContent {
  return [
    { type: 'text', text },
    {
      type: 'image',
      source: { kind: 'provider-file', provider: 'kimi', scope: 'scope-a', reference },
      name: `${text}.png`,
      mimeType: 'image/png',
      byteSize: 12,
    },
  ]
}

function input(text: string): UserInputSubmission {
  return {
    text,
    images: [{
      id: `${text}-image`,
      name: `${text}.png`,
      mimeType: 'image/png',
      byteSize: 12,
      data: { privateBytes: `${text}-raw-secret` },
    }],
  }
}

function setup(prepareUserInput: UserInputPreparer) {
  const core = createCore({
    config: { modelCredentials: { kimi: 'kimi-key' }, prepareUserInput },
  })
  const id = core.newSession({
    title: 'existing',
    settings: { vendor: 'kimi', model: 'kimi-k2.6', vendorSettings: { region: 'cn' }, thinking: true },
  })
  return { core, id, store: core.getSessionStore(id).store }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runSession).mockImplementation(async (id, content, options) => {
    const core = options.core!
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [{ id: 'turn-1', createdAt: 1, item: { role: 'user', content } }])
    store.setter(runAtom, { runId: 'run-1', status: 'running', turnId: 'turn-1' })
  })
})

describe('sendMessage prepared input transaction', () => {
  it('serializes same-session preparation and commits structured content in submission order', async () => {
    const first = deferred<PreparedUserInput>()
    const second = deferred<PreparedUserInput>()
    const prepare = vi.fn<UserInputPreparer>((submission) => (
      submission.text === 'first' ? first.promise : second.promise
    ))
    const { core, id, store } = setup(prepare)

    const firstSend = core.sendMessage(input('first'))
    const secondSend = core.sendMessage(input('second'))

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls[0][1]).toMatchObject({
      sessionId: id,
      apiKey: 'kimi-key',
      settings: { vendor: 'kimi', model: 'kimi-k2.6', thinking: true },
    })
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(runAtom)).toBeUndefined()

    const firstContent = prepared('ms://secret-first', 'first')
    first.resolve({ content: firstContent })
    expect(await firstSend).toEqual({
      accepted: true,
      status: 'started',
      sessionId: id,
      submissionSequence: 1,
    })
    await flush()
    expect(prepare).toHaveBeenCalledTimes(2)

    const secondContent = prepared('ms://secret-second', 'second')
    second.resolve({ content: secondContent })
    expect(await secondSend).toEqual({
      accepted: true,
      status: 'queued',
      sessionId: id,
      submissionSequence: 2,
    })
    expect(store.getter(itemsAtom)[0].item).toEqual({ role: 'user', content: firstContent })
    expect(store.getter(queuedUserMessagesAtom)[0]).toMatchObject({
      content: secondContent,
      targetRunId: 'run-1',
      submissionSequence: 2,
    })
    expect(JSON.stringify({
      items: store.getter(itemsAtom),
      queue: store.getter(queuedUserMessagesAtom),
    })).not.toContain('raw-secret')
  })

  it('rolls back prepared provider resources when settings change before commit', async () => {
    const pending = deferred<PreparedUserInput>()
    const rollback = vi.fn()
    const { core, id, store } = setup(() => pending.promise)
    const send = core.sendMessage(input('changed'))
    const current = core.rootStore.getter(sessionsAtom)[id]
    core.rootStore.setter(sessionsAtom, {
      ...core.rootStore.getter(sessionsAtom),
      [id]: { ...current, settings: { ...current.settings, thinking: false } },
    })

    pending.resolve({ content: prepared('ms://unused', 'changed'), rollback })
    expect(await send).toMatchObject({ accepted: false, reason: 'settings_changed' })
    expect(rollback).toHaveBeenCalledOnce()
    expect(rollback).toHaveBeenCalledWith('settings_changed')
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(runAtom)).toBeUndefined()
    expect(runSession).not.toHaveBeenCalled()
  })

  it('does not reject semantically identical settings with a different key order', async () => {
    const pending = deferred<PreparedUserInput>()
    const { core, id } = setup(() => pending.promise)
    const send = core.sendMessage(input('same settings'))
    const current = core.rootStore.getter(sessionsAtom)[id]
    core.rootStore.setter(sessionsAtom, {
      ...core.rootStore.getter(sessionsAtom),
      [id]: {
        ...current,
        settings: {
          thinking: true,
          vendorSettings: { region: 'cn' },
          model: 'kimi-k2.6',
          vendor: 'kimi',
        },
      },
    })

    pending.resolve({ content: prepared('ms://same-settings', 'same settings') })
    await expect(send).resolves.toMatchObject({ accepted: true, status: 'started' })
  })

  it('rolls back prepared content when the run becomes paused before commit', async () => {
    const pending = deferred<PreparedUserInput>()
    const rollback = vi.fn()
    const { core, store } = setup(() => pending.promise)
    const send = core.sendMessage(input('blocked'))
    store.setter(runAtom, { runId: 'paused-run', status: 'waiting_confirmation' })

    pending.resolve({ content: prepared('ms://blocked', 'blocked'), rollback })

    await expect(send).resolves.toMatchObject({ accepted: false, reason: 'run_blocked' })
    expect(rollback).toHaveBeenCalledWith('run_blocked')
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(queuedUserMessagesAtom)).toEqual([])
    expect(runSession).not.toHaveBeenCalled()
  })

  it('leaves no persistent state when provider preparation fails', async () => {
    const { core, store } = setup(() => { throw new Error('upload failed') })

    await expect(core.sendMessage(input('broken'))).resolves.toEqual({
      accepted: false,
      status: 'rejected',
      reason: 'prepare_failed',
      error: 'upload failed',
    })
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(runAtom)).toBeUndefined()
  })

  it('stopRun aborts active and not-yet-started preparation, then rolls back a late result', async () => {
    const pending = deferred<PreparedUserInput>()
    const rollback = vi.fn()
    const signals: AbortSignal[] = []
    const prepare = vi.fn<UserInputPreparer>((_, context) => {
      signals.push(context.signal)
      return pending.promise
    })
    const { core, store } = setup(prepare)
    const active = core.sendMessage(input('active'))
    const queued = core.sendMessage(input('queued'))

    core.stopRun()
    await expect(active).resolves.toMatchObject({ accepted: false, reason: 'prepare_aborted' })
    await expect(queued).resolves.toMatchObject({ accepted: false, reason: 'prepare_aborted' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(signals[0].aborted).toBe(true)
    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(runAtom)).toBeUndefined()

    pending.resolve({ content: prepared('ms://late-stop', 'active'), rollback })
    await flush()
    expect(rollback).toHaveBeenCalledWith('prepare_aborted')
  })

  it('removeSession aborts preparation and rolls back a provider result that arrives late', async () => {
    const pending = deferred<PreparedUserInput>()
    const rollback = vi.fn()
    let signal: AbortSignal | undefined
    const { core, id, store } = setup((_, context) => {
      signal = context.signal
      return pending.promise
    })
    const send = core.sendMessage(input('remove'))

    core.removeSession(id)
    await expect(send).resolves.toMatchObject({ accepted: false, reason: 'prepare_aborted' })
    expect(signal?.aborted).toBe(true)
    expect(core.rootStore.getter(sessionsAtom)[id]).toBeUndefined()
    expect(store.getter(itemsAtom)).toEqual([])

    pending.resolve({ content: prepared('ms://late-remove', 'remove'), rollback })
    await flush()
    expect(rollback).toHaveBeenCalledWith('prepare_aborted')
  })
})
