import { createStore } from '@einfach/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  IndexedDbDriver,
  MemoryDriver,
  SNAPSHOT_VERSION,
  captureSnapshot,
  hydrateFromStorage,
  parseSnapshot,
  type Snapshot,
  type StorageDriver,
} from './persistence'
import {
  activeSessionIdAtom,
  messagesBySessionAtom,
  runsBySessionAtom,
  sessionsAtom,
  setRunState,
  timelineBySessionAtom,
} from './atoms'
import type { AgentRunState, AgentSession, ChatMessage } from '../runtime/types'

// Collect teardown fns from hydrateFromStorage so listeners never leak across tests.
const teardowns: Array<() => void> = []
async function hydrate(store: Parameters<typeof hydrateFromStorage>[0], driver: StorageDriver, options?: Parameters<typeof hydrateFromStorage>[2]) {
  const teardown = await hydrateFromStorage(store, driver, options)
  teardowns.push(teardown)
  return teardown
}
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.()
})

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const session: AgentSession = {
    id: 'session-a',
    title: '会话 A',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
  }
  const message: ChatMessage = {
    id: 'msg-1',
    role: 'user',
    content: 'hi',
    createdAt: 1,
  }
  return {
    version: SNAPSHOT_VERSION,
    activeSessionId: 'session-a',
    sessions: { 'session-a': session },
    messages: { 'session-a': [message] },
    timeline: { 'session-a': [] },
    runs: {},
    ...overrides,
  }
}

describe('MemoryDriver', () => {
  it('round-trips a snapshot', async () => {
    const driver = new MemoryDriver()
    expect(await driver.load()).toBeNull()

    const snapshot = makeSnapshot()
    await driver.save(snapshot)

    const loaded = await driver.load()
    expect(loaded).toEqual(snapshot)
    expect(loaded).not.toBe(snapshot)
  })
})

describe('IndexedDbDriver', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('opens / upgrades and round-trips a snapshot', async () => {
    const driver = new IndexedDbDriver()
    expect(await driver.load()).toBeNull()

    const snapshot = makeSnapshot()
    await driver.save(snapshot)

    const loaded = await driver.load()
    expect(loaded).toEqual(snapshot)
  })

  it('returns null on a version mismatch instead of throwing', async () => {
    const driver = new IndexedDbDriver()
    await driver.save(makeSnapshot({ version: SNAPSHOT_VERSION + 999 }))
    expect(await driver.load()).toBeNull()
  })

  it('returns null on corrupt / malformed data instead of throwing', async () => {
    const driver = new IndexedDbDriver()
    // @ts-expect-error intentionally writing malformed payload
    await driver.save({ version: SNAPSHOT_VERSION, sessions: 'not-an-object' })
    expect(await driver.load()).toBeNull()
  })

  it('returns null (and does not throw) when IndexedDB is unavailable', async () => {
    const original = globalThis.indexedDB
    // @ts-expect-error simulate environment without IndexedDB
    globalThis.indexedDB = undefined
    try {
      const driver = new IndexedDbDriver()
      expect(await driver.load()).toBeNull()
      await expect(driver.save(makeSnapshot())).resolves.toBeUndefined()
    } finally {
      globalThis.indexedDB = original
    }
  })
})

describe('parseSnapshot (RF4 deep validation)', () => {
  it('accepts a well-formed snapshot', () => {
    expect(parseSnapshot(makeSnapshot())).not.toBeNull()
  })

  it('rejects a non-record payload', () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot(42)).toBeNull()
    expect(parseSnapshot([])).toBeNull()
  })

  it('rejects a version mismatch', () => {
    expect(parseSnapshot(makeSnapshot({ version: 999 }))).toBeNull()
  })

  it('rejects a null session entry (sessions:{id:null})', () => {
    const bad = makeSnapshot()
    // @ts-expect-error corrupt entry
    bad.sessions['session-a'] = null
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a session missing required fields', () => {
    const bad = makeSnapshot()
    // @ts-expect-error corrupt entry
    bad.sessions['session-a'] = { id: 'session-a' }
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects an empty sessions map', () => {
    expect(parseSnapshot(makeSnapshot({ sessions: {} }))).toBeNull()
  })

  it('rejects when activeSessionId points to a non-existent session', () => {
    expect(parseSnapshot(makeSnapshot({ activeSessionId: 'ghost' }))).toBeNull()
  })

  it('rejects a messages value that is not an array', () => {
    const bad = makeSnapshot()
    // @ts-expect-error corrupt entry
    bad.messages['session-a'] = { not: 'array' }
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a malformed message inside the array', () => {
    const bad = makeSnapshot()
    // @ts-expect-error corrupt entry
    bad.messages['session-a'] = [{ id: 'm', role: 'user' }]
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a malformed timeline event', () => {
    const bad = makeSnapshot()
    // @ts-expect-error corrupt entry
    bad.timeline['session-a'] = [{ id: 'e' }]
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a malformed run entry', () => {
    const bad = makeSnapshot()
    // @ts-expect-error corrupt entry
    bad.runs['session-a'] = { id: 'r' }
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('hydrate degrades to default state when stored snapshot is corrupt', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const defaultId = store.getter(activeSessionIdAtom)
    const corrupt = makeSnapshot()
    // @ts-expect-error corrupt entry
    corrupt.sessions['session-a'] = null
    // bypass driver validation by injecting raw
    await driver.save(corrupt)

    await hydrate(store, driver)

    // Corrupt snapshot dropped; default session preserved, never crashes.
    expect(store.getter(sessionsAtom)[defaultId]).toBeDefined()
    expect(store.getter(activeSessionIdAtom)).toBe(defaultId)
  })
})

describe('hydrateFromStorage', () => {
  it('restores atoms from a stored snapshot', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    await driver.save(makeSnapshot())

    await hydrate(store, driver)

    expect(store.getter(sessionsAtom)['session-a']).toMatchObject({ title: '会话 A' })
    expect(store.getter(activeSessionIdAtom)).toBe('session-a')
    expect(store.getter(messagesBySessionAtom)['session-a']).toHaveLength(1)
  })

  it('keeps default state when storage is empty', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const defaultSessionId = store.getter(activeSessionIdAtom)

    await hydrate(store, driver)

    expect(store.getter(activeSessionIdAtom)).toBe(defaultSessionId)
    expect(store.getter(sessionsAtom)[defaultSessionId]).toBeDefined()
  })

  it('does NOT write to storage before hydration completes (gate)', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const saveSpy = vi.spyOn(driver, 'save')

    let resolveLoad: (v: Snapshot | null) => void = () => {}
    vi.spyOn(driver, 'load').mockImplementation(
      () => new Promise<Snapshot | null>((resolve) => (resolveLoad = resolve)),
    )

    const hydratePromise = hydrate(store, driver)

    setRunState(store, store.getter(activeSessionIdAtom), {
      id: 'run-early',
      sessionId: store.getter(activeSessionIdAtom),
      status: 'running',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    })
    await Promise.resolve()
    expect(saveSpy).not.toHaveBeenCalled()

    resolveLoad(null)
    await hydratePromise
  })

  it('opens write subscription after hydration and debounces saves', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      const driver = new MemoryDriver()
      const saveSpy = vi.spyOn(driver, 'save')

      await hydrate(store, driver, { debounceMs: 50 })
      saveSpy.mockClear()

      const sessionId = store.getter(activeSessionIdAtom)
      store.setter(messagesBySessionAtom, (prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] ?? []),
          { id: 'm1', role: 'user', content: 'a', createdAt: 1 } as ChatMessage,
        ],
      }))
      store.setter(messagesBySessionAtom, (prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] ?? []),
          { id: 'm2', role: 'user', content: 'b', createdAt: 2 } as ChatMessage,
        ],
      }))

      expect(saveSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60)
      expect(saveSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes pending save on pagehide', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      const driver = new MemoryDriver()
      const saveSpy = vi.spyOn(driver, 'save')

      await hydrate(store, driver, { debounceMs: 5000 })
      saveSpy.mockClear()

      const sessionId = store.getter(activeSessionIdAtom)
      store.setter(messagesBySessionAtom, (prev) => ({
        ...prev,
        [sessionId]: [{ id: 'm1', role: 'user', content: 'a', createdAt: 1 } as ChatMessage],
      }))

      expect(saveSpy).not.toHaveBeenCalled()
      window.dispatchEvent(new Event('pagehide'))
      expect(saveSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not flush when nothing changed since last save (dirty flag)', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      const driver = new MemoryDriver()
      const saveSpy = vi.spyOn(driver, 'save')

      await hydrate(store, driver, { debounceMs: 50 })
      saveSpy.mockClear()

      // No mutation at all → pagehide should NOT save.
      window.dispatchEvent(new Event('pagehide'))
      expect(saveSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops saving after teardown (no listener leak)', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      const driver = new MemoryDriver()
      const saveSpy = vi.spyOn(driver, 'save')

      const teardown = await hydrateFromStorage(store, driver, { debounceMs: 50 })
      saveSpy.mockClear()
      teardown()

      const sessionId = store.getter(activeSessionIdAtom)
      store.setter(messagesBySessionAtom, (prev) => ({
        ...prev,
        [sessionId]: [{ id: 'm1', role: 'user', content: 'a', createdAt: 1 } as ChatMessage],
      }))
      await vi.advanceTimersByTimeAsync(100)
      window.dispatchEvent(new Event('pagehide'))

      expect(saveSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('save serialization (RF6)', () => {
  it('serializes overlapping saves so the latest snapshot wins even if writes finish out of order', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()

      // Driver whose save() completes out of order: first call resolves slowly,
      // second call resolves fast. Without serialization the stale (first) write
      // would land last and clobber the newer state.
      const completed: Snapshot[] = []
      let callIndex = 0
      const driver: StorageDriver = {
        load: async () => null,
        save: (snapshot) => {
          const delay = callIndex === 0 ? 200 : 20
          callIndex += 1
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              completed.push(snapshot)
              resolve()
            }, delay)
          })
        },
      }

      await hydrate(store, driver, { debounceMs: 10 })

      const sessionId = store.getter(activeSessionIdAtom)

      // First mutation → first save scheduled.
      store.setter(messagesBySessionAtom, (prev) => ({
        ...prev,
        [sessionId]: [{ id: 'm1', role: 'user', content: 'first', createdAt: 1 } as ChatMessage],
      }))
      await vi.advanceTimersByTimeAsync(15) // fire debounce → save #1 starts (slow, 200ms)

      // Second mutation while save #1 in-flight → save #2 should queue behind #1.
      store.setter(messagesBySessionAtom, (prev) => ({
        ...prev,
        [sessionId]: [{ id: 'm2', role: 'user', content: 'second', createdAt: 2 } as ChatMessage],
      }))
      await vi.advanceTimersByTimeAsync(15) // fire debounce for #2

      await vi.advanceTimersByTimeAsync(500) // let everything settle

      // The very last completed write must reflect the newest state ("second").
      const last = completed.at(-1)
      expect(last?.messages[sessionId]?.[0]?.content).toBe('second')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('hydrate run normalization', () => {
  it('normalizes a restored running run to stopped', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const runningRun: AgentRunState = {
      id: 'run-1',
      sessionId: 'session-a',
      status: 'running',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    }
    await driver.save(
      makeSnapshot({
        runs: { 'session-a': runningRun },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'running', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('stopped')
  })

  it('also rewrites session.status to match the normalized run (RF3)', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const runningRun: AgentRunState = {
      id: 'run-1',
      sessionId: 'session-a',
      status: 'running',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    }
    await driver.save(
      makeSnapshot({
        runs: { 'session-a': runningRun },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'running', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('stopped')
  })

  it('keeps a waiting_user run with a pendingQuestion resumable (run + session)', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const waitingRun: AgentRunState = {
      id: 'run-2',
      sessionId: 'session-a',
      status: 'waiting_user',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
      pendingQuestion: {
        id: 'q1',
        questions: [{ id: 'q1', text: '继续吗?', type: 'confirm' }],
      },
    }
    await driver.save(
      makeSnapshot({
        runs: { 'session-a': waitingRun },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'waiting_user', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('waiting_user')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('waiting_user')
  })

  it('normalizes a waiting_user run WITHOUT a pendingQuestion to stopped (run + session)', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const waitingRun: AgentRunState = {
      id: 'run-3',
      sessionId: 'session-a',
      status: 'waiting_user',
      input: 'x',
      loadedSkills: [],
      loadedTools: [],
    }
    await driver.save(
      makeSnapshot({
        runs: { 'session-a': waitingRun },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'waiting_user', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('stopped')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('stopped')
  })
})

describe('captureSnapshot', () => {
  it('serializes the current store into a snapshot shape', () => {
    const store = createStore()
    const snapshot = captureSnapshot(store)
    expect(snapshot.version).toBe(SNAPSHOT_VERSION)
    expect(snapshot.sessions).toBeDefined()
    expect(snapshot.messages).toBeDefined()
    expect(snapshot.timeline).toBeDefined()
    expect(snapshot.runs).toBeDefined()
    expect(snapshot.activeSessionId).toBe(store.getter(activeSessionIdAtom))
  })
})

function runWith(overrides: Partial<AgentRunState>): AgentRunState {
  return {
    id: 'run-1',
    sessionId: 'session-a',
    status: 'waiting_user',
    input: 'x',
    loadedSkills: [],
    loadedTools: [],
    ...overrides,
  }
}

describe('parseSnapshot deep pendingQuestion / timeline validation (RF7)', () => {
  it('rejects a run whose pendingQuestion is an empty object', () => {
    const bad = makeSnapshot({ runs: { 'session-a': runWith({ pendingQuestion: {} as never }) } })
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a pendingQuestion whose questions is not an array', () => {
    const bad = makeSnapshot({
      runs: { 'session-a': runWith({ pendingQuestion: { id: 'q', questions: 'nope' } as never }) },
    })
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a pendingQuestion with an empty questions array', () => {
    const bad = makeSnapshot({
      runs: { 'session-a': runWith({ pendingQuestion: { id: 'q', questions: [] } as never }) },
    })
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a question missing required fields', () => {
    const bad = makeSnapshot({
      runs: {
        'session-a': runWith({
          pendingQuestion: { id: 'q', questions: [{ id: 'q1' }] } as never,
        }),
      },
    })
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a question with an invalid type', () => {
    const bad = makeSnapshot({
      runs: {
        'session-a': runWith({
          pendingQuestion: {
            id: 'q',
            questions: [{ id: 'q1', text: 't', type: 'not-a-type' }],
          } as never,
        }),
      },
    })
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a question whose options is not a string array', () => {
    const bad = makeSnapshot({
      runs: {
        'session-a': runWith({
          pendingQuestion: {
            id: 'q',
            questions: [{ id: 'q1', text: 't', type: 'single-choice', options: [1, 2] }],
          } as never,
        }),
      },
    })
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('accepts a well-formed pendingQuestion', () => {
    const good = makeSnapshot({
      runs: {
        'session-a': runWith({
          pendingQuestion: {
            id: 'q',
            title: '确认',
            questions: [
              { id: 'q1', text: '继续吗?', type: 'confirm', required: true },
              { id: 'q2', text: '范围', type: 'single-choice', options: ['a', 'b'] },
            ],
          },
        }),
      },
    })
    expect(parseSnapshot(good)).not.toBeNull()
  })

  it('rejects a timeline event with an invalid kind', () => {
    const bad = makeSnapshot()
    bad.timeline['session-a'] = [
      { id: 'e', runId: 'r', kind: 'bogus', title: 't', status: 'done', timestamp: 1 } as never,
    ]
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a timeline event with an invalid status', () => {
    const bad = makeSnapshot()
    bad.timeline['session-a'] = [
      { id: 'e', runId: 'r', kind: 'tool', title: 't', status: 'bogus', timestamp: 1 } as never,
    ]
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('rejects a timeline event whose optional detail has the wrong type', () => {
    const bad = makeSnapshot()
    bad.timeline['session-a'] = [
      { id: 'e', runId: 'r', kind: 'tool', title: 't', status: 'done', timestamp: 1, detail: 5 } as never,
    ]
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('hydrate degrades to default when a stored run has pendingQuestion:{} (would crash the card)', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const defaultId = store.getter(activeSessionIdAtom)
    const corrupt = makeSnapshot({
      runs: { 'session-a': runWith({ pendingQuestion: {} as never }) },
    })
    await driver.save(corrupt)

    await hydrate(store, driver)

    // Corrupt snapshot dropped → default state, no waiting_user/pendingQuestion ghost.
    expect(store.getter(sessionsAtom)[defaultId]).toBeDefined()
    expect(store.getter(runsBySessionAtom)['session-a']).toBeUndefined()
  })
})

describe('hydrate full session normalization (RF9)', () => {
  it('sets session.status to idle when the session has no run', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    await driver.save(
      makeSnapshot({
        runs: {},
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'running', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('idle')
    expect(store.getter(runsBySessionAtom)['session-a']).toBeUndefined()
  })

  it('drops a ghost run whose sessionId points to a non-existent session', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    const ghost = runWith({ id: 'ghost', sessionId: 'gone', status: 'running' })
    await driver.save(
      makeSnapshot({
        // key "session-a" maps to a run claiming sessionId "gone" → mismatch ghost
        runs: { 'session-a': { ...ghost } },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'idle', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    // Mismatched run dropped; session falls back to idle.
    expect(store.getter(runsBySessionAtom)['session-a']).toBeUndefined()
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('idle')
  })

  it('derives session.status from the normalized run when key/sessionId/session are consistent', async () => {
    const store = createStore()
    const driver = new MemoryDriver()
    await driver.save(
      makeSnapshot({
        runs: { 'session-a': runWith({ id: 'r', sessionId: 'session-a', status: 'running' }) },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status: 'running', createdAt: 1, updatedAt: 2 },
        },
      }),
    )

    await hydrate(store, driver)

    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('stopped')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('stopped')
  })
})

describe('async teardown drains pending writes (RF10)', () => {
  it('flushes the latest dirty state on teardown and the final write is the newest', async () => {
    const completed: Snapshot[] = []
    const driver: StorageDriver = {
      load: async () => null,
      save: (snapshot) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            completed.push(snapshot)
            resolve()
          }, 20)
        }),
    }

    const store = createStore()
    // long debounce so nothing fires on its own — teardown must force the write
    const teardown = await hydrateFromStorage(store, driver, { debounceMs: 100000 })

    const sessionId = store.getter(activeSessionIdAtom)
    store.setter(messagesBySessionAtom, (prev) => ({
      ...prev,
      [sessionId]: [{ id: 'm1', role: 'user', content: 'final', createdAt: 1 } as ChatMessage],
    }))

    // teardown returns a promise that resolves only after the queue drains.
    await teardown()

    expect(completed.length).toBeGreaterThanOrEqual(1)
    expect(completed.at(-1)?.messages[sessionId]?.[0]?.content).toBe('final')
  })

  it('drains an in-flight save plus a later dirty change before resolving', async () => {
    const completed: Snapshot[] = []
    let callIndex = 0
    const driver: StorageDriver = {
      load: async () => null,
      save: (snapshot) => {
        const delay = callIndex === 0 ? 80 : 10
        callIndex += 1
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            completed.push(snapshot)
            resolve()
          }, delay)
        })
      },
    }

    const store = createStore()
    const teardown = await hydrateFromStorage(store, driver, { debounceMs: 5 })

    const sessionId = store.getter(activeSessionIdAtom)
    store.setter(messagesBySessionAtom, (prev) => ({
      ...prev,
      [sessionId]: [{ id: 'm1', role: 'user', content: 'one', createdAt: 1 } as ChatMessage],
    }))
    // let the debounce fire so save #1 (slow) is in-flight
    await new Promise((r) => setTimeout(r, 10))
    // mutate again while save #1 in-flight
    store.setter(messagesBySessionAtom, (prev) => ({
      ...prev,
      [sessionId]: [{ id: 'm2', role: 'user', content: 'two', createdAt: 2 } as ChatMessage],
    }))

    await teardown()

    // The final landed write must reflect the newest state.
    expect(completed.at(-1)?.messages[sessionId]?.[0]?.content).toBe('two')
  })
})

describe('hydrate preserves terminal run states (RF11)', () => {
  async function hydrateRun(status: AgentRunState['status'], extra: Partial<AgentRunState> = {}) {
    const store = createStore()
    const driver = new MemoryDriver()
    await driver.save(
      makeSnapshot({
        runs: { 'session-a': runWith({ id: 'r', sessionId: 'session-a', status, ...extra }) },
        sessions: {
          'session-a': { id: 'session-a', title: '会话 A', status, createdAt: 1, updatedAt: 2 },
        },
      }),
    )
    await hydrate(store, driver)
    return store
  }

  it('keeps a done run as done (not stopped)', async () => {
    const store = await hydrateRun('done')
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('done')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('done')
  })

  it('keeps an error run as error (not stopped)', async () => {
    const store = await hydrateRun('error', { error: 'boom' })
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('error')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('error')
  })

  it('keeps an idle run as idle (not stopped)', async () => {
    const store = await hydrateRun('idle')
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('idle')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('idle')
  })

  it('keeps a stopped run as stopped', async () => {
    const store = await hydrateRun('stopped')
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('stopped')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('stopped')
  })

  it('collapses a running run to stopped', async () => {
    const store = await hydrateRun('running')
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('stopped')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('stopped')
  })

  it('keeps a waiting_user run WITH a valid pendingQuestion resumable', async () => {
    const store = await hydrateRun('waiting_user', {
      pendingQuestion: { id: 'q', questions: [{ id: 'q1', text: '继续?', type: 'confirm' }] },
    })
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('waiting_user')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('waiting_user')
  })

  it('collapses a waiting_user run WITHOUT a pendingQuestion to stopped', async () => {
    const store = await hydrateRun('waiting_user')
    expect(store.getter(runsBySessionAtom)['session-a']?.status).toBe('stopped')
    expect(store.getter(sessionsAtom)['session-a']?.status).toBe('stopped')
  })
})

describe('parseSnapshot rejects sessions whose map key != session.id (RF11b)', () => {
  it('drops the whole snapshot when a session key mismatches its id', () => {
    const bad = makeSnapshot()
    // key "session-a" but the session's own id says something else
    bad.sessions['session-a'] = {
      id: 'mismatched-id',
      title: '会话 A',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
    }
    expect(parseSnapshot(bad)).toBeNull()
  })

  it('accepts when every session key === its id', () => {
    expect(parseSnapshot(makeSnapshot())).not.toBeNull()
  })
})
