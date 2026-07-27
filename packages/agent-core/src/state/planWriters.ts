import type { PlanSnapshot } from '../planning/types'
import { rootStore, sessionsAtom } from './rootStore'
import { getSessionStore } from './sessionStore'
import { planAtom, runAtom } from './sessionAtoms'
import { persistSessions } from '../runtime/persistenceBridge'
import {
  beginPerformanceDiagnostic,
  performanceNow,
} from '../observability/performanceDiagnostics'

export function getPlan(sessionId: string): PlanSnapshot | undefined {
  if (!rootStore.getter(sessionsAtom)[sessionId]) return undefined
  return getSessionStore(sessionId).store.getter(planAtom)
}

export function setPlan(sessionId: string, plan: PlanSnapshot | undefined): void {
  if (!rootStore.getter(sessionsAtom)[sessionId]) return
  const sessionStore = getSessionStore(sessionId).store
  const runId = sessionStore.getter(runAtom)?.runId
  const operation = beginPerformanceDiagnostic(
    'plan.commit',
    {
      sessionId,
      runId,
      planId: plan?.id,
      planRevision: plan?.revision,
      planStatus: plan?.status,
      stageCount: plan?.stages.length ?? 0,
    },
    { slowMs: 50 },
  )
  const atomStartedAt = performanceNow()
  sessionStore.setter(planAtom, plan)
  const sessionAtomUpdateMs = performanceNow() - atomStartedAt
  const rootStartedAt = performanceNow()
  rootStore.setter(sessionsAtom, (previous) => {
    const session = previous[sessionId]
    if (!session) return previous
    return { ...previous, [sessionId]: { ...session, plan, updatedAt: Date.now() } }
  })
  const rootMetadataUpdateMs = performanceNow() - rootStartedAt
  const persistenceDispatchStartedAt = performanceNow()
  persistSessions({
    operationId: operation.operationId,
    reason: 'plan.update',
    sessionId,
    runId,
  })
  operation.finish('ok', {
    sessionAtomUpdateMs,
    rootMetadataUpdateMs,
    persistenceDispatchMs: performanceNow() - persistenceDispatchStartedAt,
  })
}
