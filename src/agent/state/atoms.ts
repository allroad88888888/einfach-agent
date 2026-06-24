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

export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>({})

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

export function appendMessage(store: Store, sessionId: string, message: ChatMessage) {
  store.setter(messagesBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: [...(prev[sessionId] ?? []), message],
  }))
  touchSession(store, sessionId)
}

export function updateMessage(store: Store, sessionId: string, messageId: string, patch: Partial<ChatMessage>) {
  store.setter(messagesBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: (prev[sessionId] ?? []).map((message) =>
      message.id === messageId ? { ...message, ...patch } : message,
    ),
  }))
  touchSession(store, sessionId)
}

export function appendTimelineEvent(store: Store, sessionId: string, event: TimelineEvent) {
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
  store.setter(timelineBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: (prev[sessionId] ?? []).map((event) =>
      event.id === eventId ? { ...event, ...patch } : event,
    ),
  }))
}

export function setRunState(store: Store, sessionId: string, run: AgentRunState | undefined) {
  store.setter(runsBySessionAtom, (prev) => ({
    ...prev,
    [sessionId]: run,
  }))
  setSessionStatus(store, sessionId, run?.status ?? 'idle')
}

export function patchRunState(store: Store, sessionId: string, patch: Partial<AgentRunState>) {
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
  store.setter(sessionsAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      ...prev[sessionId],
      status,
      updatedAt: now(),
    },
  }))
}

export function setPendingQuestionAnswer(store: Store, questionId: string, value: AskUserAnswerValue) {
  store.setter(pendingQuestionAnswersAtom, (prev) => ({
    ...prev,
    [questionId]: value,
  }))
}

export function clearPendingQuestionAnswers(store: Store) {
  store.setter(pendingQuestionAnswersAtom, {})
}

export function getPendingQuestionAnswers(store: Store): AskUserAnswers {
  return store.getter(pendingQuestionAnswersAtom)
}

function touchSession(store: Store, sessionId: string) {
  store.setter(sessionsAtom, (prev) => ({
    ...prev,
    [sessionId]: {
      ...prev[sessionId],
      updatedAt: now(),
    },
  }))
}
