// 计划阶段回退点槽位的增量记账 —— 把通用列表机制绑到 planStageCheckpoints 上。
// ---------------------------------------------------------------------------
// 机制、理由与实测数字都在 listSlotLog.ts；本文件只负责「planStageCheckpoints 这个槽位怎么用它」。
//
// 为什么它也需要增量：每条 PlanStageCheckpoint 装的是**一整份 PlanSnapshot**（阶段开始前的
// 完整计划快照，见 planStageCheckpoint.type.ts），不是几个字段。计划的几十次阶段推进常常
// 发生在同一轮对话内，`recordStageCheckpoints`（planWriters.ts）又是这条链路上最热的写入点，
// 整值记账下每新增一个回退点都要把「已攒下的其他阶段的 plan 快照」重新存进日志两遍。
//
// 只用到 append：
//   · planWriters.ts 的整体清空（计划被换掉/清空）——写整个空数组，逆操作本就需要那一整段，
//     且一个会话里只发生几次，走整值 applier（`slot()` 自带）更贴，不构成二次开销。
//   · planStageRewind.ts 的整体替换（阶段回退截断到某个下标之前）——同上，一次丢掉一整段，
//     也走整值 applier。
// 没有 patch：回退点一旦记下就不再被修改（`recordStageCheckpoints` 明确「同一 stageId 只保留
// 最早的那个点」，不会覆盖已有条目）。没有单条 remove：移除只发生在上面两种整体替换里。

import type { PlanStageCheckpoint } from './planStageCheckpoint.type'
import { planStageCheckpointsAtom } from './sessionAtoms'
import { createListSlotLog } from './listSlotLog'
import type { SlotWriteTarget } from './sessionSlotWrite'

const planStageCheckpointsLog = createListSlotLog<PlanStageCheckpoint>({
  key: 'planStageCheckpoints',
  atom: planStageCheckpointsAtom,
  idOf: (checkpoint) => checkpoint.stageId,
})

/** 把 planStageCheckpoints 的增量还原方式登记进一本日志。由槽位表在建日志时调用。 */
export const registerPlanStageCheckpointsAppliers = planStageCheckpointsLog.register

/**
 * 追加一个阶段回退点并只记这一条的账。
 *
 * `recordStageCheckpoints` 一次可能凑出多个新回退点（一次工具调用同时把多个阶段推进
 * in_progress），调用方逐条调用本函数——每条各自成一笔账，与 `appendItemLogged` 一次只追加
 * 一条 item 是同一形状。
 */
export function appendPlanStageCheckpointLogged(
  target: SlotWriteTarget,
  checkpoint: PlanStageCheckpoint,
): void {
  planStageCheckpointsLog.append(target, checkpoint)
}
