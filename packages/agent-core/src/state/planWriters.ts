import type { PlanSnapshot } from '../planning/types'
import { sessionsAtom } from './rootAtoms'
import { itemsAtom, planAtom, planStageCheckpointsAtom, runAtom } from './sessionAtoms'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import { SESSION_SLOTS } from './sessionSlots'
import { writeSlot } from './sessionSlotWrite'
import { appendPlanStageCheckpointLogged } from './planStageCheckpointsLog'
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

  const session = core.getSessionStore(sessionId)
  const sessionStore = session.store
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
  // 热路径：这里是 planStageCheckpoints 唯一的追加点，逐条走增量记账（见
  // planStageCheckpointsLog.ts）——一次可能凑出多个新回退点，每条各自成一笔账，
  // 账里不含 fresh 之外、已经攒下的那些阶段快照。
  for (const point of fresh) {
    appendPlanStageCheckpointLogged(session, point)
  }
}

export function setPlan(sessionId: string, plan: PlanSnapshot | undefined, core: CoreInstance = defaultCore): void {
  if (!core.rootStore.getter(sessionsAtom)[sessionId]) return
  const session = core.getSessionStore(sessionId)
  const sessionStore = session.store
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
  writeSlot(session, SESSION_SLOTS.plan.key, planAtom, plan)
  // 计划被清空或整体换成另一份计划时，旧回退点里的 items 长度不再对应任何可回退的位置。
  if (!plan || !previousPlan || previousPlan.id !== plan.id) {
    if (sessionStore.getter(planStageCheckpointsAtom).length > 0) {
      writeSlot(session, SESSION_SLOTS.planStageCheckpoints.key, planStageCheckpointsAtom, [])
    }
  } else {
    recordStageCheckpoints(sessionId, previousPlan, plan, core)
  }
  const sessionAtomUpdateMs = performanceNow() - atomStartedAt
  operation.finish('ok', {
    sessionAtomUpdateMs,
  })
}
