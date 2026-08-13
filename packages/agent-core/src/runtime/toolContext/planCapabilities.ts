// runtime/toolContext/planCapabilities.ts —— ctx 上的结构化计划能力。
// 状态由宿主注入的 PlanRuntime 持有（core.planRuntime 槽），工具不得直接读写 plan atom；
// 每个入口都先 assertFresh，逐字沿用拆分前 buildToolContext 里的实现。宿主未注入 runtime 时
// 整组能力缺席（不是挂个 undefined），工具据此判「计划能力不可用」。

import type { ToolContext } from '../../tools/types'
import { getPlan as readStoredPlan, setPlan } from '../../state/planWriters'
import type { CoreInstance } from '../core/coreInstance'
import type { ToolStaleGuards } from './staleGuards'

export type PlanCapabilities = Pick<
  ToolContext,
  'getPlan' | 'createPlan' | 'executePlan' | 'updatePlan' | 'submitStageResult'
>

export function createPlanCapabilities(deps: {
  sessionId: string
  core: CoreInstance
  guards: ToolStaleGuards
}): PlanCapabilities {
  const { sessionId, core } = deps
  const { assertFresh } = deps.guards
  const planRuntime = core.planRuntime?.({
    get: () => readStoredPlan(sessionId, core),
    set: (plan) => setPlan(sessionId, plan, core),
  })

  return planRuntime ? {
    getPlan() {
      assertFresh()
      return planRuntime.get()
    },
    createPlan(input) {
      assertFresh()
      return planRuntime.create(input)
    },
    executePlan(planId, revision) {
      assertFresh()
      return planRuntime.execute(planId, revision)
    },
    updatePlan(input) {
      assertFresh()
      return planRuntime.update(input)
    },
    submitStageResult(input) {
      assertFresh()
      return planRuntime.submitStageResult(input)
    },
  } : {}
}
