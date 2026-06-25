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

// Cross-turn conversation memory (summary-buffer). `summarizedUpTo` is the
// cursor into a session's messages array up to which the raw history has been
// folded into `summary`. In M1 the cursor stays 0 and summary stays empty
// (sliding-window injection only; compression lands in M2). NOT persisted in M1
// — the persistence snapshot wires it up in M3.
export interface ConversationMemory {
  summary: string
  summarizedUpTo: number
}

const EMPTY_CONVERSATION_MEMORY: ConversationMemory = { summary: '', summarizedUpTo: 0 }

export const conversationMemoryBySessionAtom = atom<Record<string, ConversationMemory>>({})

export const timelineBySessionAtom = atom<Record<string, TimelineEvent[]>>({
  [initialSessionId]: [],
})

export const composerDraftAtom = atom<string>('')

// P2.1: artifacts produced by the `save_file` agent tool, staged per session and
// awaiting a user gesture to land on disk. Deliberately NOT persisted (it does
// not flow through the persistence snapshot / parseSnapshot — see P1 contract):
// pending artifacts are transient UI state, not durable session content.
export interface PendingArtifact {
  id: string
  filename: string
  content: string
  mimeType?: string
}

export const pendingArtifactsBySessionAtom = atom<Record<string, PendingArtifact[]>>({})

export const activePendingArtifactsAtom = atom((get) => {
  const bySession = get(pendingArtifactsBySessionAtom)
  return bySession[get(activeSessionIdAtom)] ?? []
})

// PF3: composer file attachments are scoped per session so switching sessions
// never carries one session's attached file into another's outgoing message.
// Transient UI state — NOT persisted (same rationale as pendingArtifacts).
export interface ComposerAttachment {
  name: string
  body: string
  // PF7a: a per-attachment random token used to build an unforgeable boundary
  // around the file body when it is folded into the outgoing message.
  nonce: string
}

export const attachmentsBySessionAtom = atom<Record<string, ComposerAttachment>>({})

export const activeAttachmentAtom = atom((get) => {
  const bySession = get(attachmentsBySessionAtom)
  return bySession[get(activeSessionIdAtom)]
})

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

// P2.1: stage a save_file artifact for a session. Returns the generated id.
// Like the other write-back helpers it no-ops when the session is gone (RF8
// defense-in-depth), so a late save_file from an in-flight, deleted session
// never resurrects it.
export function addPendingArtifact(
  store: Store,
  sessionId: string | undefined,
  artifact: Omit<PendingArtifact, 'id'>,
): string {
  const targetSessionId = sessionId ?? store.getter(activeSessionIdAtom)
  const id = createId('artifact')
  if (sessionMissing(store, targetSessionId)) return id
  store.setter(pendingArtifactsBySessionAtom, (prev) => ({
    ...prev,
    [targetSessionId]: [...(prev[targetSessionId] ?? []), { ...artifact, id }],
  }))
  return id
}

export function removePendingArtifact(
  store: Store,
  artifactId: string,
  sessionId: string = store.getter(activeSessionIdAtom),
) {
  store.setter(pendingArtifactsBySessionAtom, (prev) => {
    const current = prev[sessionId]
    if (!current) return prev
    const next = current.filter((artifact) => artifact.id !== artifactId)
    if (next.length === current.length) return prev
    // PF5: drop the empty bucket entirely instead of leaving an empty array.
    if (next.length === 0) {
      const without = { ...prev }
      delete without[sessionId]
      return without
    }
    return { ...prev, [sessionId]: next }
  })
}

// PF3: set or clear the per-session composer attachment. Passing `undefined`
// clears it. No-op when the session is gone (defense-in-depth, RF8 style).
export function setSessionAttachment(
  store: Store,
  sessionId: string,
  attachment: ComposerAttachment | undefined,
) {
  if (sessionMissing(store, sessionId)) return
  store.setter(attachmentsBySessionAtom, (prev) => {
    if (!attachment) {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    }
    return { ...prev, [sessionId]: attachment }
  })
}

// M1.1: read a session's conversation memory, defaulting to an empty buffer
// (summary '', cursor 0) when the session has no entry yet.
export function getConversationMemory(store: Store, sessionId: string): ConversationMemory {
  return store.getter(conversationMemoryBySessionAtom)[sessionId] ?? { ...EMPTY_CONVERSATION_MEMORY }
}

// M1.1: write a session's conversation memory. Ghost guard (RF8 style): no-op
// when the session no longer exists, so a late summarize write-back never
// resurrects a deleted session.
export function setConversationMemory(
  store: Store,
  sessionId: string,
  memory: ConversationMemory,
) {
  if (sessionMissing(store, sessionId)) return
  store.setter(conversationMemoryBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: memory,
  }))
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
  store.setter(pendingArtifactsBySessionAtom, (prev) => {
    if (!(sessionId in prev)) return prev
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
  store.setter(attachmentsBySessionAtom, (prev) => {
    if (!(sessionId in prev)) return prev
    const next = { ...prev }
    delete next[sessionId]
    return next
  })
  store.setter(conversationMemoryBySessionAtom, (prev) => {
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
