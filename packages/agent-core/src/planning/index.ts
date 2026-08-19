// @einfach-agent/core/planning 的公开入口：计划（Plan）契约类型。
//
// migrate.ts（读时迁移，只被 state/persistence/hydrate.ts 相对引用）与 runtime.ts
// （PlanRuntimeFactory 的内部再导出，只被 core 自身相对引用）不进公开面——外部消费方
// 至今都没有深导入过它们，属于 core 内部实现。

export type {
  CreatePlanInput,
  PlanMutationResult,
  PlanRuntime,
  PlanRuntimeFactory,
  PlanRuntimeStore,
  PlanSnapshot,
  PlanStage,
  PlanStageStatus,
  PlanStatus,
  StageResult,
  SubmitStageResultInput,
  UpdatePlanInput,
} from './types'
