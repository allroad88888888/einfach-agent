import type { Store } from '@einfach/core'
import {
  activeSessionIdAtom,
  messagesBySessionAtom,
  runsBySessionAtom,
  sessionsAtom,
  timelineBySessionAtom,
} from './atoms'
import type {
  AgentRunState,
  AgentSession,
  ChatMessage,
  TimelineEvent,
} from '../runtime/types'

export const SNAPSHOT_VERSION = 1

export interface Snapshot {
  version: number
  activeSessionId: string
  sessions: Record<string, AgentSession>
  messages: Record<string, ChatMessage[]>
  timeline: Record<string, TimelineEvent[]>
  runs: Record<string, AgentRunState | undefined>
}

export interface StorageDriver {
  load(): Promise<Snapshot | null>
  save(snapshot: Snapshot): Promise<void>
}

const DB_NAME = 'web-agent'
const STORE_NAME = 'state'
const SNAPSHOT_KEY = 'snapshot'

/** Deep clone that is safe for our plain-JSON snapshot shape. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RUN_STATUSES = new Set(['idle', 'running', 'waiting_user', 'done', 'stopped', 'error'])
const CHAT_ROLES = new Set(['user', 'assistant', 'system'])
const TIMELINE_KINDS = new Set(['agent', 'skill', 'tool', 'question', 'model', 'system'])
const TIMELINE_STATUSES = new Set(['pending', 'running', 'done', 'error', 'stopped'])
const QUESTION_TYPES = new Set(['text', 'single-choice', 'multi-choice', 'confirm'])

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isValidQuestionItem(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string') return false
  if (typeof value.text !== 'string') return false
  if (typeof value.type !== 'string' || !QUESTION_TYPES.has(value.type)) return false
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || !value.options.every((o) => typeof o === 'string')) {
      return false
    }
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') return false
  return true
}

/** RF7: a stored pendingQuestion must be a well-formed AskUserQuestionPayload. */
function isValidPendingQuestion(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string') return false
  if (!isOptionalString(value.title)) return false
  if (!Array.isArray(value.questions) || value.questions.length === 0) return false
  return value.questions.every(isValidQuestionItem)
}

function isValidSession(value: unknown): value is AgentSession {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    RUN_STATUSES.has(value.status) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  // Index access (not .every) so sparse-array holes read as undefined and fail.
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') return false
  }
  return true
}

function isValidMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    // role must belong to the ChatRole union, not merely be a string.
    typeof value.role === 'string' &&
    CHAT_ROLES.has(value.role) &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'number'
  )
}

function isValidTimelineEvent(value: unknown): value is TimelineEvent {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.kind === 'string' &&
    TIMELINE_KINDS.has(value.kind) &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    TIMELINE_STATUSES.has(value.status) &&
    typeof value.timestamp === 'number' &&
    isOptionalString(value.detail) &&
    isOptionalString(value.actor)
  )
}

function isValidRun(value: unknown): value is AgentRunState {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.status !== 'string' ||
    !RUN_STATUSES.has(value.status) ||
    typeof value.input !== 'string' ||
    // loadedSkills/loadedTools must be string[] (each element a string), not
    // merely arrays — a non-string element would break downstream consumers.
    !isStringArray(value.loadedSkills) ||
    !isStringArray(value.loadedTools)
  ) {
    return false
  }
  // RF7: if a pendingQuestion is present it must be a valid payload — a bad one
  // (e.g. {}) would later crash AskUserQuestionCard's questions.filter(...).
  if (value.pendingQuestion !== undefined && !isValidPendingQuestion(value.pendingQuestion)) {
    return false
  }
  if (value.error !== undefined && typeof value.error !== 'string') return false
  return true
}

function everyEntry(map: Record<string, unknown>, predicate: (value: unknown) => boolean): boolean {
  return Object.values(map).every(predicate)
}

function everyArrayEntry(
  map: Record<string, unknown>,
  itemPredicate: (value: unknown) => boolean,
): boolean {
  return Object.values(map).every(
    (value) => Array.isArray(value) && value.every(itemPredicate),
  )
}

/**
 * Validates an arbitrary loaded payload deeply. Returns a usable Snapshot or
 * null. Never throws — any bad/corrupt/version-mismatched data degrades to the
 * default state. RF4: validates session/message/timeline/run shapes plus the
 * activeSessionId reference and a non-empty sessions map.
 */
export function parseSnapshot(value: unknown): Snapshot | null {
  if (!isRecord(value)) return null
  if (value.version !== SNAPSHOT_VERSION) return null
  if (!isRecord(value.sessions)) return null
  if (!isRecord(value.messages)) return null
  if (!isRecord(value.timeline)) return null
  if (!isRecord(value.runs)) return null
  if (typeof value.activeSessionId !== 'string') return null

  const sessions = value.sessions
  const sessionIds = Object.keys(sessions)

  // Non-empty + every session well-formed.
  if (sessionIds.length === 0) return null
  if (!everyEntry(sessions, isValidSession)) return null

  // RF11b: each session's map key must match its own id — a mismatch would
  // surface as an un-selectable / un-deletable ghost session in the list.
  if (sessionIds.some((id) => (sessions[id] as AgentSession).id !== id)) return null

  // activeSessionId must reference an existing session.
  if (!sessionIds.includes(value.activeSessionId)) return null

  // messages/timeline must be arrays of well-formed items.
  if (!everyArrayEntry(value.messages, isValidMessage)) return null
  if (!everyArrayEntry(value.timeline, isValidTimelineEvent)) return null

  // runs may be undefined per session, but if present must be well-formed.
  if (
    !everyEntry(value.runs, (run) => run === undefined || run === null || isValidRun(run))
  ) {
    return null
  }

  return {
    version: SNAPSHOT_VERSION,
    activeSessionId: value.activeSessionId,
    sessions: sessions as Record<string, AgentSession>,
    messages: value.messages as Record<string, ChatMessage[]>,
    timeline: value.timeline as Record<string, TimelineEvent[]>,
    runs: value.runs as Record<string, AgentRunState | undefined>,
  }
}

/** In-memory driver for tests / fallback. */
export class MemoryDriver implements StorageDriver {
  private snapshot: Snapshot | null = null

  async load(): Promise<Snapshot | null> {
    return this.snapshot ? clone(this.snapshot) : null
  }

  async save(snapshot: Snapshot): Promise<void> {
    this.snapshot = clone(snapshot)
  }
}

/** Production driver backed by IndexedDB. Every failure degrades gracefully. */
export class IndexedDbDriver implements StorageDriver {
  private openDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) {
          resolve(null)
          return
        }
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }

  async load(): Promise<Snapshot | null> {
    const db = await this.openDb()
    if (!db) return null

    try {
      const raw = await new Promise<unknown>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
          tx.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
      return parseSnapshot(raw)
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    const db = await this.openDb()
    if (!db) return

    try {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          tx.objectStore(STORE_NAME).put(clone(snapshot), SNAPSHOT_KEY)
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
          tx.onabort = () => resolve()
        } catch {
          resolve()
        }
      })
    } catch {
      // swallow — persistence is best-effort
    } finally {
      db.close()
    }
  }
}

/** Capture the current store state into a serializable snapshot. */
export function captureSnapshot(store: Store): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    activeSessionId: store.getter(activeSessionIdAtom),
    sessions: store.getter(sessionsAtom),
    messages: store.getter(messagesBySessionAtom),
    timeline: store.getter(timelineBySessionAtom),
    runs: store.getter(runsBySessionAtom),
  }
}

/**
 * Normalize a restored run, preserving terminal/idle states (RF11). A live run
 * can't be resumed after reload because its AbortController is in-memory only,
 * so it collapses to `stopped`; everything else is kept as-is:
 *  - `running`                                   → `stopped`
 *  - `waiting_user` without a pendingQuestion    → `stopped`
 *  - `waiting_user` WITH a pendingQuestion        → kept (resumable)
 *  - `done` / `error` / `idle` / `stopped`        → kept (terminal/idle)
 */
function normalizeRunStatus(run: AgentRunState): AgentRunState {
  const collapse =
    run.status === 'running' ||
    (run.status === 'waiting_user' && !run.pendingQuestion)
  return collapse ? { ...run, status: 'stopped' as const } : run
}

/**
 * RF9: normalize the restored state per *session* (the source of truth), not per
 * run-entry:
 *  - keep a run only when its map key === run.sessionId === an existing session
 *    (drops ghost / mis-keyed runs);
 *  - each session.status is derived solely from its normalized run (run.status),
 *    or `idle` when the session has no run.
 * Also drops the `running`→`stopped` (and unresumable `waiting_user`→`stopped`)
 * collapse from RF3.
 */
function normalizeRestoredState(
  sessions: Record<string, AgentSession>,
  runs: Record<string, AgentRunState | undefined>,
): {
  sessions: Record<string, AgentSession>
  runs: Record<string, AgentRunState | undefined>
} {
  const nextSessions: Record<string, AgentSession> = {}
  const nextRuns: Record<string, AgentRunState | undefined> = {}

  for (const [sessionId, session] of Object.entries(sessions)) {
    const candidate = runs[sessionId]
    const runConsistent =
      candidate != null && candidate.sessionId === sessionId && session.id === sessionId

    if (runConsistent) {
      const normalized = normalizeRunStatus(candidate)
      nextRuns[sessionId] = normalized
      nextSessions[sessionId] = { ...session, status: normalized.status }
    } else {
      // No run, or a ghost/mis-keyed run → session is idle, run dropped.
      nextSessions[sessionId] = { ...session, status: 'idle' }
    }
  }

  return { sessions: nextSessions, runs: nextRuns }
}

function applySnapshot(store: Store, snapshot: Snapshot) {
  const { sessions, runs } = normalizeRestoredState(snapshot.sessions, snapshot.runs)

  store.setter(sessionsAtom, sessions)
  store.setter(messagesBySessionAtom, snapshot.messages)
  store.setter(timelineBySessionAtom, snapshot.timeline)
  store.setter(runsBySessionAtom, runs)

  // Guard: never point activeSessionId at a session that doesn't exist.
  const activeId = snapshot.activeSessionId
  const ids = Object.keys(sessions)
  if (ids.includes(activeId)) {
    store.setter(activeSessionIdAtom, activeId)
  } else if (ids.length > 0) {
    store.setter(activeSessionIdAtom, ids[0])
  }
}

export interface HydrateOptions {
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 400

/**
 * Hydrate the store from persistence, then open the write subscription.
 *
 * The `hydrated` gate guarantees we never write before the initial load
 * resolves — otherwise the default session would debounce-save and clobber
 * previously-stored data. Returns an async unsubscribe/teardown function that
 * flushes the latest pending state and drains the save queue before resolving
 * (RF10).
 */
export async function hydrateFromStorage(
  store: Store,
  driver: StorageDriver,
  options: HydrateOptions = {},
): Promise<() => Promise<void>> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS

  // 1) Load first (gate closed: no writes happen during this await). Re-validate
  // whatever the driver returns — never trust a driver to have validated.
  let snapshot: Snapshot | null = null
  try {
    snapshot = parseSnapshot(await driver.load())
  } catch {
    snapshot = null
  }
  if (snapshot) {
    applySnapshot(store, snapshot)
  }

  // 2) Open write subscription only after hydration completes.
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  // RF6: serialize saves through a single-slot queue. We never run two saves
  // concurrently, and only the *latest* pending snapshot is written, so an
  // out-of-order IndexedDB completion can't clobber newer state. `dirty` avoids
  // redundant flushes when nothing changed since the last write.
  let dirty = false
  let writing = false
  // RF10: track the in-flight drain so teardown can await it.
  let queuePromise: Promise<void> = Promise.resolve()

  const runQueue = async (allowAfterDispose = false) => {
    if (writing) return queuePromise
    writing = true
    queuePromise = (async () => {
      try {
        while (dirty && (allowAfterDispose || !disposed)) {
          dirty = false
          const snapshotToWrite = captureSnapshot(store)
          try {
            await driver.save(snapshotToWrite)
          } catch {
            // best-effort; drop and continue with any newer pending snapshot
          }
        }
      } finally {
        writing = false
      }
    })()
    return queuePromise
  }

  const enqueueSave = () => {
    dirty = true
    void runQueue()
  }

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty) return
    enqueueSave()
  }

  const scheduleSave = () => {
    if (disposed) return
    dirty = true
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      enqueueSave()
    }, debounceMs)
  }

  const unsubs = [
    store.sub(sessionsAtom, scheduleSave),
    store.sub(messagesBySessionAtom, scheduleSave),
    store.sub(timelineBySessionAtom, scheduleSave),
    store.sub(runsBySessionAtom, scheduleSave),
    store.sub(activeSessionIdAtom, scheduleSave),
  ]

  const onHide = () => flush()
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onHide)
    window.addEventListener('visibilitychange', onVisibility)
  }

  return async () => {
    // Stop the pending debounce, but DON'T dispose yet — we still need to write
    // the final dirty state and drain any in-flight save.
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }

    // RF10: flush the latest dirty state and wait for the queue (including an
    // in-flight save plus any change made while it ran) to fully drain.
    if (dirty || writing) {
      await runQueue(true)
    }

    disposed = true
    for (const unsub of unsubs) unsub()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
