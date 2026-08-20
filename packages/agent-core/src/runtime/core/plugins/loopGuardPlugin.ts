// 循环检测插件（Core 抽离 Stage 2a）—— 把 modelRun.ts 内联的「跨轮重复工具调用检测」搬成
// onTurnEnd 插件。跨轮累计状态放【插件闭包】，每次 assemblePlugins（每 run 一次）都是全新计数，
// 天然按 run 隔离，不需要任何全局单例。
// ---------------------------------------------------------------------------
// 契约：docs/core-plugin-extraction-blueprint.md §四/§五（PX3 LoopHooks；「循环检测 →
//   loopGuardPlugin → afterToolCall/onTurnEnd」那一行）。本轮只搬循环检测这一个关注点。
//
// 【绝对没碰】危险工具确认 / ask_user 暂停两条挂起/恢复流——它俩仍原样待在 modelRun.ts 的 loop
//   里，留 Stage 2b，本文件一行都不涉及。finish_reason 三态是兄弟 agent 的插件——本文件也不碰，
//   即便现状里 loop 检测与 finish_reason 共享 assistantHasContent 这个 turn-end 量（见下）。
//
// 【最高铁律】纯结构搬迁，行为零变化：阈值(3)、签名规范化算法、达阈值时的收尾（trace 事件名
//   'agent.loop_detected' + 全套 attrs + run 状态 'error' + 错误串）都与搬迁前逐字一致。
//
// ── 现状（modelRun.ts runToolLoop 内，每轮 model 往返收尾处）──
//   跨轮维护两份累计状态：
//     · consecutiveToolOnlyTurns —— 连续「纯工具轮」计数器（只用于 trace 的 consecutive_tool_turns）。
//     · repeatedToolSignatures   —— Map<签名, 累计次数>，某签名累计到阈值(3) 即判成环。
//   每轮：若本轮是「纯工具轮」(isToolOnlyTurn)，逐个 tool_call 算签名、累加计数、命中阈值即标记
//   loopDetected；否则两份状态清零。命中后 loop 的收尾是：streamWriter.finishPending() +
//   commitTurn() + patchRun(status:'error', error) + finishTrace('error','agent.loop_detected',attrs)
//   + return。★ 收尾里【没有】appendItem ★——纯工具轮无正文，streamWriter.flush() 在 content 非空前
//   不建条目（api/modelApi.ts 注释），故这一路对 itemsAtom 零写入（回归测试钉死：命中轮无新
//   assistant 条目）。所以本插件也【不需要】任何 ctx.store 写入——它只累计、判定、返回决策。
//
// ── 与 loop（modelRun.ts）的协作契约（集成时务必对齐）──
//   LoopHooks 的 TurnEndEvent 是 loop 与插件共享的完整契约。本插件直接读取其中的
//   assistantHasContent，不私有扩展事件或在 hook 边界断言。
//     · assistantHasContent —— 旧代码里的
//         `typeof msg?.content === 'string' && msg.content.trim().length > 0`。
//       这是一份 loop 已算好、且与 finish_reason 分支【共享】的 turn-end 量（modelRun 里只算一次），
//       故由 loop 一次算好、连同 finishReason/toolCalls 一起喂进来，避免两个插件各算一遍而漂移。
//
//   onTurnEnd 命中阈值时返回完整 TurnEndStopDecision（未命中返回 undefined = 不干预、loop 继续）。
//   命中决策带：
//     · stop:true / runStatus:'error' / reason:LOOP_DETECTED_ERROR —— 上游 TurnEndDecision 契约，
//       loop 据此终止 run + patchRun(status:'error', error:reason)。
//     · traceEventName:'agent.loop_detected' + traceAttrs —— loop 直接
//       `finishTrace('error', decision.traceEventName, decision.traceAttrs)` 一次落地（事件 + 关闭
//       turn span 都用同一份 attrs，与旧代码逐字一致）。★ 本插件【不】自己发 traceEvent ★——
//       'agent.loop_detected' 与 turn span 的关闭在旧代码里由 finishTrace 一次完成（发事件 + endSpan
//       同一份 attrs），插件既拿不到 turn span 句柄、也不能 endSpan，故把整份 attrs 交回给 loop 用
//       finishTrace 落地；插件若再自发一遍会与 finishTrace 双发同名事件。
//
// ── 搬走的符号（原先私有于 modelRun.ts，现从本文件 import；集成 agent 删 modelRun 里的旧定义）──
//   LOOP_DETECTION_THRESHOLD / LOOP_DETECTED_ERROR / toolCallSignature / normalizedArgsSignature
//   （连同其内部 helper normalizeForSignature / isPlainRecord 一并迁来，作私有实现细节）。
//   tracePreview 由 runtime/shared/preview 提供，避免插件与 modelRun 形成反向依赖。
//
// ── 判据外迁（F1）：签名规范化 + 跨轮计数 + 阈值已搬到 runtime/shared/toolRepetition ──
//   子 run【整个不装插件】，却同样要说得出「它在重复什么」，故可复用的是判据、不是插件。
//   本文件仍原样 re-export 那三个符号（阈值与两个签名函数），插件的对外面与行为一字未变：
//   「哪几轮该数」（isToolOnlyTurn / 清零）与「数到了做什么」（stop + trace attrs）都还留在这里。

import type { ModelToolCall } from '@einfach-agent/ai'
import type { TraceAttributes } from '../../../observability/port'
import { tracePreview } from '../../shared/preview'
import {
  createToolRepetitionTracker,
  LOOP_DETECTION_THRESHOLD,
  normalizedArgsSignature,
  toolCallSignature,
  type RepeatedToolCall,
} from '../../shared/toolRepetition'
import type { CoreCtx } from '../coreCtx'
import type { TurnEndDecision, TurnEndEvent } from '../loopHooks'
import type { AgentPlugin } from '../pluginApi'

// ---------------------------------------------------------------------------
// 常量与签名（数值 / 文案一字未改；阈值与签名函数的定义已迁至 shared/toolRepetition）
// ---------------------------------------------------------------------------
// 仍从本文件导出：它们是这个插件的既有对外面，主 run 侧的调用点与用例都按这里的名字读。
export { LOOP_DETECTION_THRESHOLD, normalizedArgsSignature, toolCallSignature }
// 命中循环时既作 run 的 error、又进 trace attrs.error 的唯一文案（口径唯一）。
// 只属于主 run：子 run 不因重复而终止，故这条文案不进共享判据。
export const LOOP_DETECTED_ERROR = '检测到重复工具调用循环'

// ---------------------------------------------------------------------------
// 检测本体（跨轮累计状态放闭包，per-run 隔离）
// ---------------------------------------------------------------------------
// 简介：造一个「循环检测器」——闭包里握两份累计状态，返回的函数即 onTurnEnd 的实现。
// 详情：每次调用 createLoopGuardDetector() 都是一份全新计数；loopGuardPlugin 在装配期（每 run 一次
//   assemblePlugins → 一次 plugin(api)）调它一次，故计数天然按 run 隔离，无需全局单例、无需手动清理。
//   逐轮逻辑与 modelRun.ts 旧内联块逐字对齐（isToolOnlyTurn 判据、签名累加、seenThisTurn 同轮去重、
//   命中阈值只记第一个、非纯工具轮清零两份状态）。命中即产出决策 + 全套 trace attrs。
//   跨轮计数那一半现由 shared/toolRepetition 的 tracker 承担（同轮去重 / 只记第一个 / clear 都在
//   里面），本函数保留的是主 run 独有的两件事：**哪几轮该数**（isToolOnlyTurn，否则清零）与
//   **数到了做什么**（stop 决策 + trace attrs）。
export function createLoopGuardDetector(): (
  ctx: CoreCtx,
  ev: TurnEndEvent,
) => TurnEndDecision | undefined {
  // ★ 闭包状态 = per-run 隔离的关键 ★：每个检测器实例独占这两份，互不串味。
  let consecutiveToolOnlyTurns = 0
  const repetition = createToolRepetitionTracker(LOOP_DETECTION_THRESHOLD)

  // ctx 本插件用不到（检测只吃事件里的瞬时数据、不读/写 store）——onTurnEnd 是循环内同步点，
  // 收尾写回由 loop 守卫覆盖，无需 ctx.isCurrent 自查。签名保留 ctx 以对齐 hook 形状。
  return (_ctx, ev) => {
    const toolCalls = ev.toolCalls as ModelToolCall[]
    // assistantHasContent 由 loop 算好喂进来（与 finish_reason 分支共享同一份）。
    const assistantHasContent = ev.assistantHasContent
    const isToolOnlyTurn =
      ev.finishReason === 'tool_calls' && toolCalls.length > 0 && !assistantHasContent
    let loopDetected: RepeatedToolCall | undefined
    if (isToolOnlyTurn) {
      consecutiveToolOnlyTurns += 1
      loopDetected = repetition.observeTurn(toolCalls)
    } else {
      consecutiveToolOnlyTurns = 0
      repetition.reset()
    }

    if (!loopDetected) return undefined

    // 与旧代码 `const attrs: TraceAttributes = {...}` 逐字一致——loop 拿去 finishTrace 一次落地
    // （既发 'agent.loop_detected' 事件、又把 turn span 关成 error，attrs 同一份）。
    const traceAttrs: TraceAttributes = {
      loop_detected: true,
      toolName: loopDetected.toolName,
      callId: loopDetected.callId,
      argsPreview: tracePreview(loopDetected.args),
      repeated_count: loopDetected.repeatedCount,
      consecutive_tool_turns: consecutiveToolOnlyTurns,
      threshold: LOOP_DETECTION_THRESHOLD,
      error: LOOP_DETECTED_ERROR,
    }
    return {
      stop: true,
      runStatus: 'error',
      reason: LOOP_DETECTED_ERROR,
      traceEventName: 'agent.loop_detected',
      traceAttrs,
    }
  }
}

// 简介：循环检测插件（PX2 AgentPlugin）——装配期建一个 per-run 检测器、注册进 onTurnEnd 槽。
// 详情：createLoopGuardDetector() 在此调用一次 = 本 run 一份全新计数（assemblePlugins 每 run 跑一遍
// plugin(api)），共享 TurnEndEvent 直接交给检测器，逻辑全在检测器闭包里。
export const loopGuardPlugin: AgentPlugin = (api) => {
  const detect = createLoopGuardDetector()
  api.hook('onTurnEnd', (ctx, ev) => detect(ctx, ev))
}
