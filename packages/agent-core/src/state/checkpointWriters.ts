// checkpoint 写入 / 回退写入器（P6）—— 操作某会话自己的 store。
// ---------------------------------------------------------------------------
// 「截断式回退」语义（C2，git reset --hard）：
//   · commitCheckpoint —— 一轮对话收尾时，把当前 items 整体快照进 checkpointsAtom，
//     turnIndex = 快照进列表前的原长度；游标 currentTurnIndex 推进到「新长度 - 1」。
//   · jumpToCheckpoint  —— 跳回第 N 轮：恢复该轮 items，并**丢弃第 N 轮之后**的全部轮
//     （把 checkpointsAtom 截断到 N+1 长度），游标回到 N。不做分支保留。
//   · rewindBeforeCheckpoint —— 撤回第 N 轮：恢复到该轮最后一条用户消息之前，并丢弃
//     第 N 轮及之后的 checkpoint；用于「回退并编辑」而不是恢复该轮结束快照。
// C4 不可变：commit 直接持有当时的 items 引用（后续对 itemsAtom 的更新都是整体替换、
//   不原地改动，所以旧快照恒定有效）；jump 用 slice / 直接赋值做整体替换。
//
// 【实例化 · 第 2 期穿线】两个导出的写入器都在既有参数之后加了默认参数 core（CoreInstance，
//   默认 defaultCore）：函数体内一律经 core.rootStore / core.getSessionStore(id) 读写，
//   不再摸模块全局 rootStore / getSessionStore。默认值就是 defaultCore——而 defaultCore.rootStore
//   正是 rootStore.ts 导出的那个 Store 引用、defaultCore.getSessionStore 也是 sessionStore.ts
//   导出函数背后委托的同一实现，所以不传 core 的调用点（现状全部调用点）行为逐字不变。
//   传入独立 core（如 createCoreInstance() 造的实例）时，读写只落在那个实例自己的 store，
//   与 defaultCore 互不污染（第 3 期隔离雏形）。

import { sessionsAtom } from './rootStore'
import {
  checkpointsAtom,
  contextCheckpointAtom,
  currentTurnIndexAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
} from './sessionAtoms'
import type {
  Checkpoint,
  CheckpointState,
  PlanStageCheckpoint,
} from './checkpoint.type'
import type { ConversationItem } from './core.type'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import type { PlanSnapshot } from '../planning/types'

// ghost guard：会话未在 core.rootStore 登记 → 后续写入应 no-op（C7）。
// 直接查登记表；不经 core.getSessionStore（后者未命中会创建 store，会复活幽灵会话）。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

// checkpoint 恢复只更新运行时 atom；动态状态的唯一持久化来源是 recovery v1。
// 阶段回退点跟随同一份快照回退：它记录的 itemCount 指向被恢复的那段 items，
// 若留着回退点不动，轮级回退后它们会指向已经被截断掉的位置。
function restorePlan(
  id: string,
  plan: PlanSnapshot | undefined,
  stagePoints: PlanStageCheckpoint[] | undefined,
  core: CoreInstance,
): void {
  core.getSessionStore(id).store.setter(planAtom, plan)
  core.getSessionStore(id).store.setter(planStageCheckpointsAtom, stagePoints ?? [])
}

// 没有阶段回退点的会话（绝大多数普通对话）不必给每条 checkpoint 都塞一个空数组。
function stageCheckpointsSnapshot(
  points: PlanStageCheckpoint[],
): PlanStageCheckpoint[] | undefined {
  return points.length > 0 ? points : undefined
}

/**
 * 提交一次 checkpoint：把当前会话 store 里的 items 快照追加到 checkpointsAtom。
 * turnIndex 取「追加前的列表长度」，游标推进到该 turnIndex。
 * core 默认 defaultCore：不传时与旧版模块全局逐字等价；传入独立 core 则只读写该实例的 store。
 */
export function commitCheckpoint(
  id: string,
  label: string,
  core: CoreInstance = defaultCore,
  checkpointState: CheckpointState = { kind: 'completed' },
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const items = store.getter(itemsAtom)
  const plan = store.getter(planAtom)
  // 新快照的 turnIndex = 现有 checkpoint 数量（即它入列表后的下标）。
  const turnIndex = store.getter(checkpointsAtom).length
  const cp: Checkpoint = {
    turnIndex,
    label,
    createdAt: Date.now(),
    items,
    kind: checkpointState.kind,
    finishReason: checkpointState.finishReason,
    plan,
    planStageCheckpoints: stageCheckpointsSnapshot(store.getter(planStageCheckpointsAtom)),
    contextCheckpoint: store.getter(contextCheckpointAtom),
  }
  store.setter(checkpointsAtom, (prev) => [...prev, cp])
  store.setter(currentTurnIndexAtom, turnIndex)
}

/**
 * 覆盖一个已存在 checkpoint 的 items 快照。
 * 用于长任务执行中的增量落盘；只更新同一轮，不允许越界追加。
 */
export function updateCheckpoint(
  id: string,
  turnIndex: number,
  label: string,
  core: CoreInstance = defaultCore,
  checkpointState?: CheckpointState,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const list = store.getter(checkpointsAtom)
  const previous = list[turnIndex]
  if (!previous) return
  const state = checkpointState ?? (previous.kind
    ? { kind: previous.kind, finishReason: previous.finishReason }
    : undefined)
  const checkpoint: Checkpoint = {
    turnIndex,
    label,
    createdAt: previous.createdAt,
    items: store.getter(itemsAtom),
    ...(state ? { kind: state.kind, finishReason: state.finishReason } : {}),
    plan: store.getter(planAtom),
    planStageCheckpoints: stageCheckpointsSnapshot(store.getter(planStageCheckpointsAtom)),
    contextCheckpoint: store.getter(contextCheckpointAtom),
  }
  store.setter(checkpointsAtom, list.map((item, index) => (index === turnIndex ? checkpoint : item)))
  store.setter(currentTurnIndexAtom, turnIndex)
}

/**
 * 跳回第 turnIndex 轮（截断式回退，C2）：
 * 恢复该轮的 items 快照，截断 checkpointsAtom 到 turnIndex+1，游标回到 turnIndex。
 * turnIndex 越界（对应 checkpoint 不存在）时直接 no-op，不改动任何 atom。
 * core 默认 defaultCore，语义同 commitCheckpoint。
 */
export function jumpToCheckpoint(
  id: string,
  turnIndex: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const list = store.getter(checkpointsAtom)
  const cp = list[turnIndex]
  // 越界（含负数）→ cp 为 undefined，直接 no-op，保持各 atom 原样。
  if (!cp) {
    return
  }
  // 恢复该轮的 items（整体替换，C4）。
  store.setter(itemsAtom, cp.items)
  store.setter(contextCheckpointAtom, cp.contextCheckpoint)
  restorePlan(id, cp.plan, cp.planStageCheckpoints, core)
  // 截断：丢弃第 turnIndex 轮之后的全部快照（git reset --hard 语义）。
  store.setter(checkpointsAtom, list.slice(0, turnIndex + 1))
  store.setter(currentTurnIndexAtom, turnIndex)
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
 * 回退到某个计划阶段开始之前（阶段级回退，轮级 jumpToCheckpoint 的计划内部版本）：
 * 恢复该阶段的回退点快照、把对话截断回打点时的长度，并丢弃该点及其之后的全部回退点。
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

  // itemCount 是打点时的全局下标。轮级回退可能已经把对话截得更短，slice 在这种情况下
  // 自然退化成「保持原样」，不会越界。截断后再抹掉尾部未闭合的 tool_calls（见上方注释）。
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

/**
 * 撤回第 turnIndex 轮：
 * 恢复到该 checkpoint 中最后一条用户消息之前，丢弃该轮及之后的全部 checkpoint，
 * 游标回到前一轮。首轮撤回后 checkpoints 为空、游标为 -1。
 * checkpoint 不存在或其中没有用户消息时整体 no-op。
 */
export function rewindBeforeCheckpoint(
  id: string,
  turnIndex: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const list = store.getter(checkpointsAtom)
  const cp = list[turnIndex]
  if (!cp) return

  let userIndex = -1
  for (let index = cp.items.length - 1; index >= 0; index -= 1) {
    if (cp.items[index].item.role === 'user') {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return

  store.setter(itemsAtom, cp.items.slice(0, userIndex))
  // 撤回目标轮本身时，恢复的是“上一轮结束后”的计划；撤回首轮则回到无计划状态。
  const previousTurn = list[turnIndex - 1]
  store.setter(contextCheckpointAtom, previousTurn?.contextCheckpoint)
  restorePlan(id, previousTurn?.plan, previousTurn?.planStageCheckpoints, core)
  store.setter(checkpointsAtom, list.slice(0, turnIndex))
  store.setter(currentTurnIndexAtom, turnIndex - 1)
}
