import { describe, expect, it, vi } from 'vitest'
import type { UserMessageContent } from '@web-agent/ai'
import { createCore } from './core/createCore'
import { checkpointsAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { queuedUserMessagesAtom } from '../state/sessionTransientAtoms'
import type { PreparedUserInput, UserInputPreparer } from './userInputPreparation'

vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  persistCurrentRunRecovery: vi.fn(),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

function preparedContent(text: string): UserMessageContent {
  return [
    { type: 'text', text },
    {
      type: 'image',
      source: {
        kind: 'provider-file',
        provider: 'kimi',
        scope: 'scope-private',
        reference: `ms://${text}`,
      },
      name: `${text}.png`,
      mimeType: 'image/png',
      byteSize: 12,
    },
  ]
}

function setupPendingPreparation() {
  const pending = deferred<PreparedUserInput>()
  const rollback = vi.fn()
  let signal: AbortSignal | undefined
  const prepareUserInput = vi.fn<UserInputPreparer>((_, context) => {
    signal = context.signal
    return pending.promise
  })
  const core = createCore({ config: { prepareUserInput } })
  const id = core.newSession({
    title: 'rollback cancellation',
    settings: { vendor: 'kimi', model: 'kimi-k2.6', region: 'cn' },
  })
  const store = core.getSessionStore(id).store
  const send = core.sendMessage({
    text: 'late input',
    images: [{
      id: 'image-1',
      name: 'late.png',
      mimeType: 'image/png',
      byteSize: 12,
      data: new Uint8Array([1, 2, 3]),
    }],
  })
  return { core, id, store, pending, rollback, signal: () => signal, send }
}

async function expectCancelledWithoutLateCommit(
  setup: ReturnType<typeof setupPendingPreparation>,
): Promise<void> {
  await expect(setup.send).resolves.toMatchObject({
    accepted: false,
    reason: 'prepare_aborted',
  })
  expect(setup.signal()?.aborted).toBe(true)

  setup.pending.resolve({
    content: preparedContent('late-result'),
    rollback: setup.rollback,
  })
  await flush()

  expect(setup.rollback).toHaveBeenCalledOnce()
  expect(setup.rollback).toHaveBeenCalledWith('prepare_aborted')
  expect(setup.store.getter(itemsAtom)).toEqual([])
  expect(setup.store.getter(queuedUserMessagesAtom)).toEqual([])
}

describe('checkpoint commands cancel pending submissions', () => {
  it('revertToTurn aborts deferred preparation before restoring a checkpoint', async () => {
    const setup = setupPendingPreparation()
    setup.store.setter(checkpointsAtom, [{
      turnIndex: 0,
      label: 'empty checkpoint',
      createdAt: 1,
      items: [],
      kind: 'completed',
    }])

    setup.core.revertToTurn(0)

    await expectCancelledWithoutLateCommit(setup)
  })

  it('withdraw without a checkpoint aborts deferred preparation before rewinding items', async () => {
    const setup = setupPendingPreparation()
    setup.store.setter(itemsAtom, [{
      id: 'current-user',
      createdAt: 1,
      item: { role: 'user', content: 'withdraw me' },
    }])
    setup.store.setter(runAtom, { runId: 'stopped-run', status: 'stopped' })

    setup.core.withdrawCurrentTurnToDraft()

    await expectCancelledWithoutLateCommit(setup)
  })
})
