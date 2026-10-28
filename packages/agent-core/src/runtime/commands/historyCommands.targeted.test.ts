import { describe, expect, it, vi } from 'vitest'
import { createCore } from '../core/createCore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { setRun } from '../../state/sessionWriters'

function response(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function waitDone(core: ReturnType<typeof createCore>, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (core.getSessionStore(sessionId).store.getter(runAtom)?.status === 'done') return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('run did not finish')
}

async function realTurns(count = 3) {
  let calls = 0
  const fetchImpl = vi.fn(async () => response(`答${++calls}`))
  const core = createCore({ config: { modelCredentials: { deepseek: 'key' }, fetchImpl } })
  const sessionId = core.newSession({ settings: { vendor: 'deepseek', model: 'model' } })
  for (let turn = 1; turn <= count; turn += 1) {
    await core.sendMessage({ text: `问${turn}` }, { sessionId })
    await waitDone(core, sessionId)
  }
  const users = core.getSessionStore(sessionId).store.getter(itemsAtom)
    .filter((item) => item.item.role === 'user')
  return { core, sessionId, users, fetchImpl }
}

function contents(core: ReturnType<typeof createCore>, sessionId: string): string[] {
  return core.getSessionStore(sessionId).store.getter(itemsAtom).map((item) =>
    String('content' in item.item ? item.item.content : ''))
}

describe('targeted message history commands', () => {
  it('retracts the middle real sendMessage turn by user append, then restores its recorded reply without fetching', async () => {
    const { core, sessionId, users, fetchImpl } = await realTurns()
    const userEntries = core.getSessionStore(sessionId).history.getState().entries
      .filter((entry) => entry.ops.some((op) => op.key === 'items:append' && (op.after as { item?: { role?: string } })?.item?.role === 'user'))
    const assistantEntries = core.getSessionStore(sessionId).history.getState().entries
      .filter((entry) => entry.ops.some((op) => op.key === 'items:append' && (op.after as { item?: { role?: string } })?.item?.role === 'assistant'))
    expect(userEntries[0]?.label).toBeUndefined()
    expect(userEntries[1]?.label).toBe(assistantEntries[0]?.label)
    expect(userEntries[2]?.label).toBe(assistantEntries[1]?.label)

    expect(core.retractTurn(users[1]!.id, sessionId).ok).toBe(true)
    expect(contents(core, sessionId)).toEqual(['问1', '答1'])
    expect(core.getSessionStore(sessionId).store.getter(core.sessionTurnHistoryAtom(sessionId)).turns
      .filter((turn) => turn.state === 'retracted').map((turn) => turn.userItem.id))
      .toEqual([users[1]!.id, users[2]!.id])

    const requests = fetchImpl.mock.calls.length
    expect(core.restoreRetractedTurn(users[1]!.id, sessionId).ok).toBe(true)
    expect(contents(core, sessionId)).toEqual(['问1', '答1', '问2', '答2'])
    expect(fetchImpl).toHaveBeenCalledTimes(requests)
  })

  it('restoring a later turn linearly restores earlier turns and leaves only later placeholders', async () => {
    const { core, sessionId, users } = await realTurns(3)
    core.retractTurn(users[0]!.id, sessionId)

    expect(core.restoreRetractedTurn(users[1]!.id, sessionId).ok).toBe(true)
    expect(contents(core, sessionId)).toEqual(['问1', '答1', '问2', '答2'])
    expect(core.getSessionStore(sessionId).store.getter(core.sessionTurnHistoryAtom(sessionId)).turns
      .filter((turn) => turn.state === 'retracted').map((turn) => turn.userItem.id))
      .toEqual([users[2]!.id])
  })

  it('targets the explicit session and drops stale redo targets after a new branch', async () => {
    const { core, sessionId, users } = await realTurns(2)
    const other = core.newSession({ settings: { vendor: 'deepseek', model: 'model' } })
    core.selectSession(other)
    core.retractTurn(users[1]!.id, sessionId)
    expect(contents(core, sessionId)).toEqual(['问1', '答1'])
    expect(contents(core, other)).toEqual([])

    await core.sendMessage({ text: '新分支' }, { sessionId })
    await waitDone(core, sessionId)
    expect(core.restoreRetractedTurn(users[1]!.id, sessionId)).toMatchObject({
      ok: false,
      refusal: 'turn_not_restorable',
      entries: 0,
    })
    expect(core.getSessionStore(sessionId).store.getter(core.sessionTurnHistoryAtom(sessionId)).turns
      .some((turn) => turn.userItem.id === users[1]!.id)).toBe(false)
  })

  it('stops an in-flight run before retracting and restores a stopped state instead of permanent busy', async () => {
    const { core, sessionId, users } = await realTurns(2)
    setRun(sessionId, { runId: 'live', turnId: 'live-turn', status: 'running' }, core)

    expect(core.retractTurn(users[1]!.id, sessionId)).toMatchObject({ ok: true, stoppedRun: true })
    expect(core.restoreRetractedTurn(users[1]!.id, sessionId).ok).toBe(true)
    expect(core.getSessionStore(sessionId).store.getter(runAtom)?.status).toBe('stopped')
    expect(core.getSessionStore(sessionId).store.getter(core.sessionTurnHistoryAtom(sessionId)).turns[1]?.willStopRun)
      .not.toBe(true)
  })
})
