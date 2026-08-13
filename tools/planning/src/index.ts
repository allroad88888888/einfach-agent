// tools-planning —— @web-agent/tools-planning：planning 域内置工具的桶文件 + 注册器（TSPLIT TS2）。
// 依赖：仅 @web-agent/core（工具抽象 ToolRegistry + 本域用到的 core 特性）。core 不反向依赖本包 —— 单向无环。
import type { ToolRegistry } from '@web-agent/core/tools'
import { getPlanTool } from './get-plan/get-plan'
import { createPlanTool } from './create-plan/create-plan'
import { updatePlanTool } from './update-plan/update-plan'
import { executePlanTool } from './execute-plan/execute-plan'
import { submitStageResultTool } from './submit-stage-result/submit-stage-result'
export { createDefaultPlanRuntime, PlanRuntime } from './planRuntime'

export { getPlanTool, createPlanTool, updatePlanTool, executePlanTool, submitStageResultTool }

/** 把 planning 域全部工具注册进给定 registry（幂等：同名覆盖）。 */
export function registerPlanningTools(registry: ToolRegistry): void {
  for (const tool of [getPlanTool, createPlanTool, updatePlanTool, executePlanTool, submitStageResultTool]) {
    registry.register(tool)
  }
}
