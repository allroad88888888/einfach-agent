import type { PlanSnapshot } from '../planning/types'
import { sessionsAtom } from './rootAtoms'
import { itemsAtom, planAtom, planStageCheckpointsAtom, runAtom } from './sessionAtoms'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import {
  beginPerformanceDiagnostic,
  performanceNow,
} from '../observability/performanceDiagnostics'

export function getPlan(sessionId: string, core: CoreInstance = defaultCore): PlanSnapshot | undefined {
  if (!core.rootStore.getter(sessionsAtom)[sessionId]) return undefined
  return core.getSessionStore(sessionId).store.getter(planAtom)
}

// 阶段回退点的唯一打点处：某阶段从「非 in_progress」转入 in_progress 的那一刻，
// 记下变更前的计划快照和当时的对话长度。setPlan 是所有计划写入的唯一出口，
// 所以无论推进来自 execute_plan、评估通过自动进入下一阶段，还是阶段回滚后重开，都会被覆盖到。
//
// 同一 stageId 只保留最早的那个点：阶段失败重试或被回滚后会再次转 in_progress，
// 若覆盖成「重试前」，用户就再也回不到该阶段第一次开始之前了。
function recordStageCheckpoints(
  sessionId: string,
  previous: PlanSnapshot,
  next: PlanSnapshot,
  core: CoreInstance,
): void {
  const started = next.stages.filter((stage) => (
    stage.status === 'in_progress'
    && previous.stages.find((item) => item.id === stage.id)?.status !== 'in_progress'
  ))
  if (started.length === 0) return

  const sessionStore = core.getSessionStore(sessionId).store
  const existing = sessionStore.getter(planStageCheckpointsAtom)
  const fresh = started
    .filter((stage) => !existing.some((point) => point.stageId === stage.id))
    .map((stage) => ({
      stageId: stage.id,
      plan: previous,
      itemCount: sessionStore.getter(itemsAtom).length,
      createdAt: Date.now(),
    }))
  if (fresh.length === 0) return
  sessionStore.setter(planStageCheckpointsAtom, [...existing, ...fresh])
}

export function setPlan(sessionId: string, plan: PlanSnapshot | undefined, core: CoreInstance = defaultCore): void {
  if (!core.rootStore.getter(sessionsAtom)[sessionId]) return
  const sessionStore = core.getSessionStore(sessionId).store
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
  const previousPlan = sessionStore.getter(planAtom)
  sessionStore.setter(planAtom, plan)
  // 计划被清空或整体换成另一份计划时，旧回退点里的 items 长度不再对应任何可回退的位置。
  if (!plan || !previousPlan || previousPlan.id !== plan.id) {
    if (sessionStore.getter(planStageCheckpointsAtom).length > 0) {
      sessionStore.setter(planStageCheckpointsAtom, [])
    }
  } else {
    recordStageCheckpoints(sessionId, previousPlan, plan, core)
  }
  const sessionAtomUpdateMs = performanceNow() - atomStartedAt
  operation.finish('ok', {
    sessionAtomUpdateMs,
  })
}
