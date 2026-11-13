import { describe, expect, it } from 'vitest'
import { createCore } from '../runtime/core/createCore'
import { setToolCallOutcomeFacts } from '../runtime/toolCallOutcomeFacts'
import type { RunState } from './core.type'
import { runAtom } from './sessionAtoms'
import { patchRun, setRun } from './sessionWriters'
import { writeRunLogged } from './runStateLog'

function seeded(count = 0) {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test' } })
  const session = core.getSessionStore(id)
  setRun(id, {
    runId: 'run-1', turnId: 'turn-1', status: 'running',
    toolCallOutcomes: Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `call-${index}`, { state: 'outcomeKnown', updatedAt: 1 },
    ])),
  }, core)
  session.history.clear()
  return { core, id, session }
}

describe('run journal growth', () => {
  it('status updates and one tool outcome have constant journal size regardless of older calls', () => {
    function bytes(count: number) {
      const { core, id, session } = seeded(count)
      patchRun(id, { status: 'awaiting_tool' }, core)
      const run = session.store.getter(runAtom)!
      patchRun(id, { toolCallOutcomes: {
        ...run.toolCallOutcomes, latest: { state: 'outcomeUnknown', updatedAt: 2 },
      } }, core)
      return JSON.stringify(session.history.getState()).length
    }
    expect(bytes(1_000)).toBe(bytes(1))
    expect(bytes(1_000)).toBeLessThan(1_024)
  })

  it('grows linearly across hundreds of tool lifecycles through the real outcome writer', () => {
    function bytes(count: number) {
      const { core, id, session } = seeded()
      for (let index = 0; index < count; index += 1) {
        const calls = [`call-${index}`]
        setToolCallOutcomeFacts(id, calls, 'notStarted', core)
        setToolCallOutcomeFacts(id, calls, 'outcomeUnknown', core)
        patchRun(id, { status: 'awaiting_tool' }, core)
        setToolCallOutcomeFacts(id, calls, 'outcomeKnown', core)
        patchRun(id, { status: 'running' }, core)
      }
      expect(Object.keys(session.store.getter(runAtom)!.toolCallOutcomes!)).toHaveLength(count)
      expect(session.history.getState().entries).toHaveLength(count * 5)
      return new TextEncoder().encode(JSON.stringify(session.history.getState())).length
    }
    const short = bytes(200)
    const long = bytes(400)
    expect(long).toBeLessThan(short * 2.2)
    expect(long).toBeLessThan(1_000_000)
  })
})

describe('run journal replay', () => {
  it('undoes a multi-write transaction without losing unrelated outcomes or intermediate fields', () => {
    const { core, id, session } = seeded(10)
    const before = session.store.getter(runAtom)
    session.history.transaction('batch', () => {
      setToolCallOutcomeFacts(id, ['new-a', 'new-b'], 'notStarted', core)
      patchRun(id, { status: 'awaiting_tool', error: 'pending' }, core)
      setToolCallOutcomeFacts(id, ['new-a'], 'outcomeUnknown', core)
      patchRun(id, { error: undefined, status: 'running' }, core)
    })
    const after = session.store.getter(runAtom)
    expect(session.history.getState().entries).toHaveLength(1)
    expect(session.history.undo()).toBe(true)
    expect(session.store.getter(runAtom)).toStrictEqual(before)
    expect(session.history.redo()).toBe(true)
    expect(session.store.getter(runAtom)).toStrictEqual(after)
  })

  it('preserves absent, undefined and empty outcome maps through JSON and bidirectional replay', () => {
    const { session } = seeded()
    const base: RunState = { runId: 'run-1', status: 'stopped' }
    const states: RunState[] = [
      base,
      { ...base, toolCallOutcomes: {} },
      { ...base, toolCallOutcomes: { a: { state: 'notStarted', updatedAt: 1 } } },
      { ...base, toolCallOutcomes: { b: { state: 'outcomeUnknown', updatedAt: 2 } } },
      { ...base, toolCallOutcomes: undefined },
      base,
      { ...base, error: 'error', pendingQuestion: null },
      { ...base, error: undefined },
    ]
    session.store.setter(runAtom, () => base)
    for (const state of states.slice(1)) writeRunLogged(session, state)
    const json = JSON.stringify(session.history.getState())
    session.history.clear()
    expect(session.history.hydrate(JSON.parse(json))).toBe(true)
    for (const state of states.slice(0, -1).reverse()) {
      expect(session.history.undo()).toBe(true)
      expect(session.store.getter(runAtom)).toStrictEqual(state)
    }
    for (const state of states.slice(1)) {
      expect(session.history.redo()).toBe(true)
      expect(session.store.getter(runAtom)).toStrictEqual(state)
    }
  })

  it('preserves run creation, replacement, removal and turn labels', () => {
    const { core, id, session } = seeded()
    session.store.setter(runAtom, undefined)
    const first: RunState = { runId: 'a', turnId: 't-a', status: 'stopped' }
    const second: RunState = { runId: 'b', turnId: 't-b', status: 'stopped' }
    setRun(id, first, core)
    patchRun(id, { status: 'interrupted' }, core)
    setRun(id, second, core)
    setRun(id, undefined, core)
    expect(session.history.getState().entries.map((entry) => entry.label)).toEqual(['t-a', 't-a', 't-b', 't-b'])
    for (const state of [second, { ...first, status: 'interrupted' }, first, undefined]) {
      expect(session.history.undo()).toBe(true)
      expect(session.store.getter(runAtom)).toStrictEqual(state)
    }
    for (let index = 0; index < 4; index += 1) expect(session.history.redo()).toBe(true)
    expect(session.store.getter(runAtom)).toBeUndefined()
  })

  it('ignores unchanged writes and refuses a delta aimed at a different run', () => {
    const { core, id, session } = seeded(2)
    const initial = session.store.getter(runAtom)!
    setRun(id, { ...initial }, core)
    expect(session.history.getState().entries).toHaveLength(0)
    patchRun(id, { status: 'stopped' }, core)
    const replacement = { ...initial, runId: 'different' }
    session.store.setter(runAtom, () => replacement)
    expect(session.history.undo()).toBe(false)
    expect(session.store.getter(runAtom)).toBe(replacement)
    expect(session.history.getState().cursor).toBe(1)
  })
})
