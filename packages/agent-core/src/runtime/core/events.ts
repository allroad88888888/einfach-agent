// 规范化事件流 AgentEvent + 从 atom 派生的投影器（消费方可替换的核心）。
// ---------------------------------------------------------------------------
// 契约（core-plugin-extraction-blueprint §六 PX5）：观察 = 订阅 atom。core 额外吐一条【规范化
//   事件投影】，让 React 之外的消费方（TUI / RPC / SDK）也能观察同一条流 —— core 不认识具体前端。
//   本投影器从【稳定 atom】itemsAtom / runAtom 无损派生事件：只订阅 + 读 atom + 回调，
//   【绝不 setter 写任何 atom】（纯观察，PX4 只读约定）。这是【加法】——React 侧继续直读 atom，
//   本文件不替换、不改动任何既有行为。
//
// 本 Stage 只做【能从 atom 无损派生】的 run 级 + message 级事件。turn / tool 级更细的粒度
//   （tool_call_started / tool_result / turn_end 等）承载「此刻还没进 store 的瞬时数据」，
//   无法从 atom 派生 —— 必须由 loop 在执行点主动发射，留待后续（见文末 TODO）。本 Stage
//   绝不碰 loop（modelRun / planning 在并行改），只订阅 atom。

import type { Store } from '@einfach/core'
import { getSessionStore } from '../../state/sessionStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import type { ConversationItem, RunState, RunStatus } from '../../state/core.type'

// 简介：run_end 触发的「终态 / 等待态」子集 —— run 在这些状态上【结束或暂停】一段生命周期。
// 详情：与 RunStatus 里「活跃 / 过渡态」（idle / running / awaiting_tool）互补 —— 后者只推进、
//   不闭合生命周期，故不发 run_end。这个子集与蓝图 §六 / 任务约定的 run_end.status 逐字对齐。
export type RunEndStatus =
  | 'done'
  | 'error'
  | 'stopped'
  | 'waiting_user'
  | 'waiting_confirmation'
  | 'waiting_plan_approval'

// 完整性门：用 `satisfies Record<RunEndStatus, true>` 强制列全 —— 日后往 RunEndStatus 加成员
//   却漏填这里，tsc 会直接报错（键缺失 / 多余都拦）。故这张表始终是 RunEndStatus 的权威枚举。
const RUN_END_STATUS_FLAGS = {
  done: true,
  error: true,
  stopped: true,
  waiting_user: true,
  waiting_confirmation: true,
  waiting_plan_approval: true,
} satisfies Record<RunEndStatus, true>

// 简介：判定某 RunStatus 是否为「终态 / 等待态」（run_end 触发集）。
// 详情：走 hasOwnProperty 而非 `in`，避免命中原型链上的键（防御性，虽然 RunStatus 成员都不与
//   Object.prototype 键重名）。返回类型守卫，命中后把 status 收窄成 RunEndStatus 供 run_end 复用。
export function isRunEndStatus(status: RunStatus): status is RunEndStatus {
  return Object.prototype.hasOwnProperty.call(RUN_END_STATUS_FLAGS, status)
}

// 简介：规范化 AgentEvent 联合 —— core 吐出的这条流，谁都能消费。
// 详情：本 Stage 四个成员全部【能从 itemsAtom / runAtom 无损派生】。用「item / run」语汇（我们自己的
//   状态核心词），不照抄 pi 的 message/turn 形状。带 runId 的两个是生命周期边界；message_appended
//   携带整条 ConversationItem（消费方按 item.role 自行收窄）；run_status_changed 携带原始状态串 + 可选 error。
export type AgentEvent =
  // run 进入 running（每个 runId 只发一次；多轮 running↔awaiting_tool 往返不重发）。生命周期边界「开」。
  | { type: 'run_start'; runId: string }
  // run 进入终态 / 等待态。生命周期边界「合」；一个 run 若中途 waiting_* 再 resume，可闭合多段。
  | { type: 'run_end'; runId: string; status: RunEndStatus }
  // itemsAtom 尾部新增了一条条目（只发【增量】，绝不重放整段历史）。
  | { type: 'message_appended'; item: ConversationItem }
  // runAtom 的 status 发生了变化（携带原始状态 + 出错时的 error 串）。
  | { type: 'run_status_changed'; status: RunStatus; error?: string }
// TODO(turn / tool 级)：tool_call_started / tool_result / turn_end 等更细粒度事件承载「此刻还没进
//   store 的瞬时数据」（工具入参、finish_reason、单轮往返边界），无法从 atom 无损派生 —— 需 loop
//   在执行点主动发射。留待 loop 接线（蓝图 §四 LoopHooks）。本 Stage 不碰 loop。

// 简介：取数组末尾条目的 id（空数组为 undefined）—— 增量 diff 的「末尾标识」基线。
function tailItemId(items: ConversationItem[]): string | undefined {
  return items.length > 0 ? items[items.length - 1].id : undefined
}

// 简介：订阅某会话的规范化事件流（PX5 投影器）。
// 详情：拿到该会话的 store（getSessionStore(sessionId).store），订阅 itemsAtom 与 runAtom，把
//   atom 变化【无损】投影成 AgentEvent 回调给 onEvent。返回一个 unsubscribe（清理两条订阅）。
//   纯观察：只 getter / sub / 回调，绝不 setter 写任何 atom。事件仅覆盖【订阅之后】的变化 ——
//   订阅时先把 items 长度 / run 快照存成基线，不重放已有历史。
export function subscribeAgentEvents(
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
): () => void {
  const store: Store = getSessionStore(sessionId).store

  // ---- message 级：itemsAtom 的增量 diff ----------------------------------
  // 难点：订阅回调拿到的是整段新数组，必须只发【新增】的条目，不能每次变化就重放全部（消费方会
  //   收到重复）。基线 = 上次见到的条目数 + 末尾条目 id。仅当【纯 append】时发新增的尾部切片；
  //   截断 / revert / 前缀被换一律不发，只把基线对齐到当前。绝不重放整段历史。
  //   ★ 判据是【边界启发式】而非整段前缀比对：只校验「数组变长【且】旧末尾条目 id 仍在原位」。
  //   它精确覆盖本 app 实际的全部写入模式（只 append / 截断 revert / 就地 finalize 最后一条）——
  //   这些模式下「旧末尾仍在原位」严格等价于「前缀未被替换」。唯一漏网的是「改写中段前缀却恰好
  //   保住边界元素、同时追加」这种写法，本 app 不产生；若日后真出现，这里会误发多余增量，届时
  //   需升级成逐条前缀比对。故此处不写「前缀未被替换」那种强措辞，如实说是边界启发式。
  let lastCount = store.getter(itemsAtom).length
  let lastTailId = tailItemId(store.getter(itemsAtom))

  const unsubscribeItems = store.sub(itemsAtom, () => {
    const next = store.getter(itemsAtom)
    const isPureAppend =
      next.length > lastCount &&
      (lastCount === 0 || next[lastCount - 1]?.id === lastTailId)
    if (isPureAppend) {
      // 只发 [lastCount, next.length) 这段新增；slice 产新数组，绝不触碰（可能被 DEV freeze 的）原数组。
      for (const item of next.slice(lastCount)) {
        onEvent({ type: 'message_appended', item })
      }
    }
    lastCount = next.length
    lastTailId = tailItemId(next)
  })

  // ---- run 级：runAtom → run_start / run_status_changed / run_end ----------
  // 基线 = 订阅时的 run 快照。startedRunId 记「已发过 run_start 的 runId」，保证每个 run 只发一次
  //   run_start（多轮 running↔awaiting_tool 往返不重发）；订阅时若 run 已越过 idle，视作【已启动】，
  //   不为它补发 run_start（只投影订阅之后真正开始的 run）。
  let prevRun: RunState | undefined = store.getter(runAtom)
  let startedRunId: string | undefined =
    prevRun && prevRun.status !== 'idle' ? prevRun.runId : undefined

  const unsubscribeRun = store.sub(runAtom, () => {
    const next = store.getter(runAtom)
    const prev = prevRun
    prevRun = next
    if (!next) return // run 被清空（undefined）—— 非生命周期事件，不发。

    // 同一 run 的状态基线：runId 变了则旧状态属于上一个 run、不作数（视作新 run 的首次状态）。
    const baselineStatus = prev?.runId === next.runId ? prev?.status : undefined
    const statusChanged = baselineStatus !== next.status

    // run_start：该 runId 首次进入 running。放最前 —— 生命周期边界「开」在细节之前。
    if (next.status === 'running' && next.runId !== startedRunId) {
      startedRunId = next.runId
      onEvent({ type: 'run_start', runId: next.runId })
    }
    // run_status_changed：status 真的变了才发（含出错时的 error 串；error 缺省则不带该字段）。
    if (statusChanged) {
      onEvent(
        next.error === undefined
          ? { type: 'run_status_changed', status: next.status }
          : { type: 'run_status_changed', status: next.status, error: next.error },
      )
    }
    // run_end：进入终态 / 等待态（相对基线的新进入）。放最后 —— 生命周期边界「合」在细节之后。
    if (statusChanged && isRunEndStatus(next.status)) {
      onEvent({ type: 'run_end', runId: next.runId, status: next.status })
    }
  })

  return () => {
    unsubscribeItems()
    unsubscribeRun()
  }
}
