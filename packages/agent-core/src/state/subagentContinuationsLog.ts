// 子 Agent 续跑槽位的增量记账 —— 把通用列表机制绑到 subagentContinuations 上。
// ---------------------------------------------------------------------------
// 机制与理由在 listSlotLog.ts；本文件只负责「subagentContinuations 这个槽位怎么用它」。
//
// 为什么它也需要增量：这个数组随子 agent 数量无界增长，每条 `spec` 是完整的续跑描述符
// （JsonValue，常常整段装着 delegate 调用的 prompt），而且是高频写 —— 每个子 agent 的状态迁移
// （queued → outcome_unknown → interrupted）都要记一账。整值记账下，随便一个子 agent 的状态
// 迁移都要把「当前跑着的全部子 agent 描述」存进日志两遍，子 agent 数一多就是二次开销。
//
// append 与 patch 都在用：queueChildContinuations 批量建子任务时，既要 patch 父节点（把新
// childId 挂进它的嵌套子列表）又要 append 新条目；fenceChildContinuation 与
// markChildContinuationTerminal 都是按 childId 原地迁移状态，走 patch。
// **没有 remove 写入器**：终态条目要保留到父聚合边界才清（见 continuationStore.test.ts 里
// 「retains terminal output ... until a later parent aggregation boundary」的用例），真正的清除
// 还没实现。刻意不预先包一个没人调的 `removeSubagentContinuationLogged`：它的测试只会覆盖
// listSlotLog 的通用 remove（pendingArtifactsLog 已经覆盖过），等于给一条无人走的路径伪造覆盖率。
// 真要实现清除时，`continuationsLog.remove` 就在手边。

import type { SubagentContinuationV1 } from './recoverySnapshot.type'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'
import { createListSlotLog } from './listSlotLog'
import type { SlotWriteTarget } from './sessionSlotWrite'

const continuationsLog = createListSlotLog<SubagentContinuationV1>({
  key: 'subagentContinuations',
  atom: subagentContinuationsAtom,
  idOf: (continuation) => continuation.childId,
})

/** 把 subagentContinuations 的增量还原方式登记进一本日志。由槽位表在建日志时调用。 */
export const registerSubagentContinuationsAppliers = continuationsLog.register

/** 追加一条新排队的子任务续跑记录，只记这一条的账。 */
export function appendSubagentContinuationLogged(
  target: SlotWriteTarget,
  continuation: SubagentContinuationV1,
): void {
  continuationsLog.append(target, continuation)
}

/** 按 childId 合并 patch，只记这一条的账。找不到该 id 时整体 no-op。 */
export function patchSubagentContinuationLogged(
  target: SlotWriteTarget,
  childId: string,
  patch: Partial<SubagentContinuationV1>,
): void {
  continuationsLog.patch(target, childId, patch)
}
