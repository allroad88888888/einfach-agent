import type { PlanSnapshot } from '../planning/types'
import { rootStore, sessionsAtom } from './rootStore'
import { getSessionStore } from './sessionStore'
import { planAtom } from './sessionAtoms'
import { persistSessions } from '../runtime/persistenceBridge'

export function getPlan(sessionId: string): PlanSnapshot | undefined {
  if (!rootStore.getter(sessionsAtom)[sessionId]) return undefined
  return getSessionStore(sessionId).store.getter(planAtom)
}

export function setPlan(sessionId: string, plan: PlanSnapshot | undefined): void {
  if (!rootStore.getter(sessionsAtom)[sessionId]) return
  getSessionStore(sessionId).store.setter(planAtom, plan)
  rootStore.setter(sessionsAtom, (previous) => {
    const session = previous[sessionId]
    if (!session) return previous
    return { ...previous, [sessionId]: { ...session, plan, updatedAt: Date.now() } }
  })
  persistSessions()
}
