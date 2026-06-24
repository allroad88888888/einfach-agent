import { atom, createStore, type Store } from '@einfach/core'
import type {
  AgentRunState,
  AgentSession,
  AskUserAnswers,
  AskUserAnswerValue,
  ChatMessage,
  RunStatus,
  TimelineEvent,
} from '../runtime/types'

const initialSessionId = 'session-default'

const now = () => Date.now()

export const createId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

const initialSession: AgentSession = {
  id: initialSessionId,
  title: 'Web Agent',
  status: 'idle',
  createdAt: now(),
  updatedAt: now(),
}

const initialMessage: ChatMessage = {
  id: createId('msg'),
  role: 'assistant',
  content: 'Web Agent 已就绪。当前运行在浏览器内，支持 skills、lazy tools 和 AskUserQuestion。',
  createdAt: now(),
}

export const agentStore = createStore()

export const sessionsAtom = atom<Record<string, AgentSession>>({
  [initialSessionId]: initialSession,
})

export const activeSessionIdAtom = atom<string>(initialSessionId)

export const messagesBySessionAtom = atom<Record<string, ChatMessage[]>>({
  [initialSessionId]: [initialMessage],
})

export const runsBySessionAtom = atom<Record<string, AgentRunState | undefined>>({})

export const timelineBySessionAtom = atom<Record<string, TimelineEvent[]>>({
  [initialSessionId]: [],
})

export const composerDraftAtom = atom<string>('')

// RF5: AskUser answers are scoped per session so concurrent waiting_user runs
// never cross-contaminate. The backing atom keeps a map keyed by sessionId; the
// public `pendingQuestionAnswersAtom` is a derived read-only view of the active
// session's answers (flat Record<questionId, value>) for backward compatibility.
export const pendingQuestionAnswersBySessionAtom = atom<
  Record<string, Record<string, AskUserAnswerValue>>
>({})

export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>((get) => {
  const bySession = get(pendingQuestionAnswersBySessionAtom)
  return bySession[get(activeSessionIdAtom)] ?? {}
})

export const activeSessionAtom = atom((get) => {
  const sessions = get(sessionsAtom)
  return sessions[get(activeSessionIdAtom)]
})

export const activeMessagesAtom = atom((get) => {
  const messages = get(messagesBySessionAtom)
  return messages[get(activeSessionIdAtom)] ?? []
})

export const activeRunAtom = atom((get) => {
  const runs = get(runsBySessionAtom)
  return runs[get(activeSessionIdAtom)]
})

export const activeTimelineAtom = atom((get) => {
  const timeline = get(timelineBySessionAtom)
  return timeline[get(activeSessionIdAtom)] ?? []
})

export const isBusyAtom = atom((get) => {
  const run = get(activeRunAtom)
  return run?.status === 'running' || run?.status === 'waiting_user'
})

export const canStopAtom = atom((get) => get(activeRunAtom)?.status === 'running')

// RF8: every write-back helper is a no-op when the target session no longer
// exists. This is defense-in-depth against late writes from an in-flight run
// whose session was deleted (which would otherwise resurrect it — especially
// touchSession/setSessionStatus, whose `{...prev[id]}` would create a ghost
// session with missing fields). createSession seeds the session *before*
// writing, so the normal flow is unaffected.
function sessionMissing(store: Store, sessionId: string) {
  return !store.getter(sessionsAtom)[sessionId]
}

export function appendMessage(store: Store, sessionId: string, message: ChatMessage) {
  if (sessionMissing(store, sessionId)) return
  store.setter(messagesBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: [...(prev[sessionId] ?? []), message],
  }))
  touchSession(store, sessionId)
}

export function updateMessage(store: Store, sessionId: string, messageId: string, patch: Partial<ChatMessage>) {
  if (sessionMissing(store, sessionId)) return
  store.setter(messagesBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: (prev[sessionId] ?? []).map((message) =>
      message.id === messageId ? { ...message, ...patch } : message,
    ),
  }))
  touchSession(store, sessionId)
}

export function appendTimelineEvent(store: Store, sessionId: string, event: TimelineEvent) {
  if (sessionMissing(store, sessionId)) return
  store.setter(timelineBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: [...(prev[sessionId] ?? []), event],
  }))
}

export function updateTimelineEvent(
  store: Store,
  sessionId: string,
  eventId: string,
  patch: Partial<TimelineEvent>,
) {
  if (sessionMissing(store, sessionId)) return
  store.setter(timelineBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: (prev[sessionId] ?? []).map((event) =>
      event.id === eventId ? { ...event, ...patch } : event,
    ),
  }))
}

export function setRunState(store: Store, sessionId: string, run: AgentRunState | undefined) {
  if (sessionMissing(store, sessionId)) return
  store.setter(runsBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: run,
  }))
  setSessionStatus(store, sessionId, run?.status ?? 'idle')
}

export function patchRunState(store: Store, sessionId: string, patch: Partial<AgentRunState>) {
  if (sessionMissing(store, sessionId)) return
  const current = store.getter(runsBySessionAtom)[sessionId]
  if (!current) return

  const nextRun = { ...current, ...patch }
  store.setter(runsBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: nextRun,
  }))

  if (patch.status) {
    setSessionStatus(store, sessionId, patch.status)
  }
}

export function setSessionStatus(store: Store, sessionId: string, status: RunStatus) {
  if (sessionMissing(store, sessionId)) return
  store.setter(sessionsAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      ...prev[sessionId],
      status,
      updatedAt: now(),
    },
  }))
}

export function setPendingQuestionAnswer(
  store: Store,
  questionId: string,
  value: AskUserAnswerValue,
  sessionId: string = store.getter(activeSessionIdAtom),
) {
  store.setter(pendingQuestionAnswersBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      ...(prev[sessionId] ?? {}),
      [questionId]: value,
    },
  }))
}

export function clearPendingQuestionAnswers(
  store: Store,
  sessionId: string = store.getter(activeSessionIdAtom),
) {
  store.setter(pendingQuestionAnswersBySessionAtom, (prev) => {
    if (!(sessionId in prev)) return prev
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
}

export function getPendingQuestionAnswers(
  store: Store,
  sessionId: string = store.getter(activeSessionIdAtom),
): AskUserAnswers {
  return store.getter(pendingQuestionAnswersBySessionAtom)[sessionId] ?? {}
}

export function createSession(store: Store, title = '新会话'): string {
  const id = createId('session')
  const timestamp = now()
  const session: AgentSession = {
    id,
    title,
    status: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  store.setter(sessionsAtom, (prev) => ({ ...prev, [id]: session }))
  store.setter(messagesBySessionAtom, (prev) => ({ ...prev, [id]: [] }))
  store.setter(timelineBySessionAtom, (prev) => ({ ...prev, [id]: [] }))
  store.setter(activeSessionIdAtom, id)

  return id
}

export function selectSession(store: Store, sessionId: string) {
  if (!store.getter(sessionsAtom)[sessionId]) return
  store.setter(activeSessionIdAtom, sessionId)
}

export function deleteSession(store: Store, sessionId: string) {
  const sessions = store.getter(sessionsAtom)
  if (!sessions[sessionId]) return

  const remainingIds = Object.keys(sessions).filter((id) => id !== sessionId)
  const isActive = store.getter(activeSessionIdAtom) === sessionId

  // RF1: move the active pointer to a valid fallback BEFORE removing the
  // session, so `activeSessionAtom` never resolves to `undefined` in the
  // intermediate publish (einfach publishes after every setter). `createSession`
  // (used when deleting the last session) seeds its own collections and selects
  // itself first, so the active session always exists at render time.
  if (isActive) {
    if (remainingIds.length === 0) {
      createSession(store, 'Web Agent')
    } else {
      store.setter(activeSessionIdAtom, remainingIds[0])
    }
  } else if (remainingIds.length === 0) {
    // Defensive: deleting the only (non-active) session — rebuild a default.
    createSession(store, 'Web Agent')
  }

  // Now drop the target session and all of its associated collections.
  store.setter(sessionsAtom, (prev) => {
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
  store.setter(messagesBySessionAtom, (prev) => {
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
  store.setter(timelineBySessionAtom, (prev) => {
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
  store.setter(runsBySessionAtom, (prev) => {
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
  store.setter(pendingQuestionAnswersBySessionAtom, (prev) => {
    if (!(sessionId in prev)) return prev
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
}

function touchSession(store: Store, sessionId: string) {
  if (sessionMissing(store, sessionId)) return
  store.setter(sessionsAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      ...prev[sessionId],
      updatedAt: now(),
    },
  }))
}
