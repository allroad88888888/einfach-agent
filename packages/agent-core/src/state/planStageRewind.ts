// 计划阶段回退写入器 —— 把某会话的对话与计划退回某个阶段开始之前。
// ---------------------------------------------------------------------------
// 本文件从原 checkpointWriters.ts 拆出。那里原有四个轮级 undo 写入器
// （commitCheckpoint / updateCheckpoint / jumpToCheckpoint / rewindBeforeCheckpoint），
// 已随用户 undo 迁移到 einfach 的事务日志（createHistory）整体删除；留下的只有阶段级回退，
// 因为它的输入 planStageCheckpointsAtom 在 RecoverySnapshotV1 里，与轮级快照无关。
//
// core 参数默认 defaultCore：不传时读写默认实例的 store；传入独立 core 则只落在那个实例。

import { sessionsAtom } from './rootStore'
import {
  contextCheckpointAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
} from './sessionAtoms'
import type { PlanStageCheckpoint } from './planStageCheckpoint.type'
import type { ConversationItem } from './core.type'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import type { PlanSnapshot } from '../planning/types'

// ghost guard：会话未在 core.rootStore 登记 → 后续写入应 no-op（C7）。
// 直接查登记表；不经 core.getSessionStore（后者未命中会创建 store，会复活幽灵会话）。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

// 阶段回退点跟随同一份快照回退：它记录的 itemCount 指向被恢复的那段 items，
// 若留着回退点不动，回退后它们会指向已经被截断掉的位置。
function restorePlan(
  id: string,
  plan: PlanSnapshot | undefined,
  stagePoints: PlanStageCheckpoint[] | undefined,
  core: CoreInstance,
): void {
  core.getSessionStore(id).store.setter(planAtom, plan)
  core.getSessionStore(id).store.setter(planStageCheckpointsAtom, stagePoints ?? [])
}

/**
 * 阶段回退点是在**工具执行过程中**打的：execute_plan / submit_stage_result 推进阶段时才调
 * setPlan，而此刻发起该调用的 assistant(tool_calls) 已经进了 items、它的 tool result 还没回填。
 * 直接按 itemCount 截断会留下一条无人应答的 tool_calls，下一次请求必被接口 400 拒绝
 * （"An assistant message with 'tool_calls' must be followed by tool messages"）。
 *
 * 这里把尾部未闭合的那条 assistant 连同它已回填的部分结果一起丢掉 —— 它正是启动该阶段的
 * 那次调用，本就属于被回退掉的那一段。并发批可能只回填了部分结果，因此判定按「该 assistant
 * 的每个 call id 都有对应 tool 结果」来做，而不是只看最后一条是不是 assistant。
 *
 * 只需检查最后一条 assistant：协议保证上一批工具结果全部回填后才会产生下一条 assistant，
 * 更早的配对不可能残缺。
 */
function dropUnclosedToolCalls(items: ConversationItem[]): ConversationItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const message = items[index].item
    if (message.role !== 'assistant') continue
    const callIds = (message.tool_calls ?? []).map((call) => call.id)
    if (callIds.length === 0) return items
    const answered = new Set(
      items.slice(index + 1)
        .map((entry) => entry.item)
        .filter((entry) => entry.role === 'tool')
        .map((entry) => entry.tool_call_id),
    )
    return callIds.every((callId) => answered.has(callId)) ? items : items.slice(0, index)
  }
  return items
}

/**
 * 回退到某个计划阶段开始之前：恢复该阶段的回退点快照、把对话截断回打点时的长度，
 * 并丢弃该点及其之后的全部回退点。
 * 没有对应回退点（旧会话、或该阶段从未开始）时返回 undefined，由调用方决定降级行为。
 *
 * 恢复出的计划**不复用**快照里的旧 revision，而是从当前 revision 继续向前发号：
 * revision 是评估回写的乐观锁令牌，回退若把它退回旧值，第一遍执行残留的后台 evaluator
 * （持有当时的 revision）就可能在重跑过程中正好匹配上，把过期评估写进新一轮执行。
 * 只向前发号可保证任何用过的 revision 永不复现，僵尸回写一律 fail-closed。
 */
export function revertToPlanStageCheckpoint(
  id: string,
  stageId: string,
  core: CoreInstance = defaultCore,
): PlanStageCheckpoint | undefined {
  if (sessionMissing(id, core)) return undefined
  const store = core.getSessionStore(id).store
  const points = store.getter(planStageCheckpointsAtom)
  const index = points.findIndex((point) => point.stageId === stageId)
  const point = points[index]
  if (!point) return undefined

  const current = store.getter(planAtom)
  // 计划已被换掉或清空时，回退点指向的计划已经不是当前这份，整体 no-op。
  if (!current || current.id !== point.plan.id) return undefined

  // itemCount 是打点时的全局下标；slice 越界时自然退化成「保持原样」。
  // 截断后再抹掉尾部未闭合的 tool_calls（见上方注释）。
  store.setter(itemsAtom, dropUnclosedToolCalls(store.getter(itemsAtom).slice(0, point.itemCount)))
  // 阶段回退丢弃了摘要所覆盖的尾部消息；让下一次请求从保留的原始历史重新生成摘要。
  store.setter(contextCheckpointAtom, undefined)
  restorePlan(
    id,
    { ...point.plan, revision: current.revision + 1, updatedAt: Date.now() },
    // 该点及其之后的回退点都指向刚被丢弃的那段执行，一并截断。
    points.slice(0, index),
    core,
  )
  return point
}
