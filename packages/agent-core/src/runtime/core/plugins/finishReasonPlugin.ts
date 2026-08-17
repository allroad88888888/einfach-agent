// finish_reason 异常三态插件（Core 抽离 Stage 2a）—— 把 modelRun.ts 内联的「finish_reason 三态
// 收尾」抽成 onTurnEnd 插件。
// ---------------------------------------------------------------------------
// 契约：docs/core-plugin-extraction-blueprint.md §四/§五（PX3 LoopHooks；「finish_reason 三态 →
//   finishReasonPlugin → onTurnEnd」那一行）。本文件只搬这一个关注点。
// 【最高铁律】纯结构搬迁，行为零变化：条目正文（含系统标注文案逐字）、run 收成 error、
//   commit/落盘、trace 都必须与搬迁前逐字一致。三份文案常量原样从 modelRun.ts 搬来（一字未改）。
//
// ── 关注点原貌（modelRun.ts 的 runToolLoop，回填工具结果那一步之前）──
//   一轮 model 往返收尾，若 finish_reason 属于标准异常原因或 provider extension
//   且【不是 length+有 tool_calls 的可恢复截断】，就：
//     ① 往 itemsAtom 追加/改写一条带「系统标注」的 assistant 条目（有正文则正文+ITEM_NOTICE，
//        无正文则单独 STANDALONE_NOTICE）；
//     ② 把 run 置成 status:'error' + finishError；③ commit checkpoint 落盘；④ 退出 loop。
//   （length+有 tool_calls 是可恢复截断——半截 arguments JSON——不在此列，留给坏 JSON 闸门。）
//
// ── 关键分工（本插件 vs loop / 集成 agent），务必对齐 ──
// 【流式 finalize 机制留在 loop，本插件不碰】：streamWriter.finalize(msg)/finishPending、50ms
//   节流对账全部留在 loop。流式已建过条目时（Case A），系统标注由 loop 侧
//   `streamWriter.finalize(msg, undefined, FINISH_REASON_ITEM_NOTICES[reason])` 追加——因为完整
//   正文只活在 streamWriter 的闭包 content 里，插件从 store 里只能拿到「最后一次节流 flush 的快照」，
//   自己去拼标注会把末尾那截文字顶掉（正是要挡在插件外的流式风险）。
// 【本插件只负责】：① 依据共享 turn-end 契约判定 finish_reason 是否异常三态；② 产出对应中文
//   notice 文案（沿用三份常量的逐字内容）；③ 仅在【没有流式条目】时（Case B，非流式响应）通过
//   ctx.store.setter 往 itemsAtom【追加】那条「系统标注」条目（对应旧代码 `if (!streamWriter.hasItem()
//   && isCurrentRun) appendItem(...)` 那一段）；④ 返回完整 TurnEndStopDecision。
// 【loop / 集成 agent 收到 decision 后负责】：setContextStats / commit checkpoint（写入结构化
//   kind / finishReason）/ persist / patchRun status /
//   finishTrace('agent.finish_abnormal') / 退出。即「条目内容插件写，run 收尾 loop 做」。
//
// ── 判据与文案不在本文件（盘点 E2 的处置）──
//   FINISH_REASON_ERRORS / FINISH_REASON_ITEM_NOTICES / FINISH_REASON_STANDALONE_NOTICES 与
//   AbnormalFinishReason / isAbnormalFinishReason 统一落在中立的 runtime/finishReason.ts，
//   本插件与 loop、子 Agent 一样只是消费方——文案不随「谁来收尾」而变，换插件也不该断。

import { itemsAtom } from '../../../state/sessionAtoms'
import type { ConversationItem } from '../../../state/core.type'
import { newId } from '../../newId'
import type { CoreCtx } from '../coreCtx'
import {
  getAbnormalFinishReason,
  type TurnEndDecision,
  type TurnEndEvent,
} from '../loopHooks'
import {
  FINISH_REASON_ERRORS,
  FINISH_REASON_ITEM_NOTICES,
  FINISH_REASON_STANDALONE_NOTICES,
} from '../../finishReason'
import type { AgentPlugin } from '../pluginApi'
import { assistantItemFromMessage } from '../../shared/preview'
import { appendItemToSession } from '../../../state/sessionWriters'

// 简介：finish_reason 三态收尾本体——从 modelRun.ts 的 runToolLoop 内联代码逐字搬来（异常分流那段）。
// 详情：非异常三态 → 返回 undefined（不干预，loop 继续）。length+有 tool_calls 是可恢复截断
//   （不在此终止，留给坏 JSON 闸门）→ 同样返回 undefined。其余异常态：仅在无流式条目时补一条
//   系统标注 assistant 条目（ctx.store 裸 setter，PX4；`ctx.isCurrent()` 对应旧 isCurrentRun 守卫，
//   短路顺序与旧代码 `!hasItem() && isCurrentRun` 一致），并返回 { stop, runStatus:'error', reason }。
export function applyFinishReason(
  ctx: CoreCtx,
  ev: TurnEndEvent,
): TurnEndDecision | undefined {
  const finishReason = getAbnormalFinishReason(ev)
  if (!finishReason) return undefined

  const finishError = FINISH_REASON_ERRORS[finishReason]
  const finishNotice = FINISH_REASON_ITEM_NOTICES[finishReason]

  // 非流式响应下 streamWriter 没建过条目，这里补一条纯文本的，让用户看得见断在哪 ——
  // 没有正文的异常终止下 assistantHasContent
  // 必为 false：有内容就「正文+标注」（沿用原逻辑），没内容就单独落一条「仅含标注」的 assistant
  // 条目（去掉前导换行，让这条独立条目单看时不是从空行起头）。流式已建条目（Case A）时标注已由
  // loop 的 finalize 追加，此处 hasStreamedItem 为真 → 跳过，避免重复。
  // ctx.isCurrent() 对应旧 isCurrentRun(id, runId) 守卫（ghost + stale-run 双查）；onTurnEnd 在
  // model 往返 await 之后被调，写前自查（PX4）。短路顺序 `!hasStreamedItem && isCurrent` 与旧代码一致。
  if (!ev.hasStreamedItem && ctx.isCurrent()) {
    const msg = ev.msg
    const assistantHasContent = typeof msg?.content === 'string' && msg.content.trim().length > 0
    const noticeContent = assistantHasContent
      ? `${msg?.content ?? ''}${finishNotice}`
      : FINISH_REASON_STANDALONE_NOTICES[finishReason]
    // 走 state/ 的写入器：ctx 结构性满足 SlotWriteTarget，这一笔因此记进本会话的事务日志。
    // 调不到 appendItem(id, item, core) 是因为 CoreCtx 按契约不给 CoreInstance；
    // 会话存在性由上面的 ctx.isCurrent() 覆盖，ghost guard / touchSession 在此不需要。
    const noticeItem: ConversationItem = {
      id: newId(),
      createdAt: Date.now(),
      item: assistantItemFromMessage(msg, noticeContent),
    }
    appendItemToSession(ctx, noticeItem)
  }

  // 条目内容插件写完，run 收尾（commit checkpoint 落盘 + patchRun status:'error' + 退出）交给
  // loop：完整 decision 要求本轮后终止 run；runStatus / reason / traceEventName 由 loop 直接消费。
  return {
    stop: true,
    runStatus: 'error',
    reason: finishError,
    traceEventName: 'agent.finish_abnormal',
  }
}

// 简介：finish_reason 三态插件（PX2 AgentPlugin）——装配期把 applyFinishReason 注册进 onTurnEnd 槽。
// 详情：TurnEndEvent 是共享完整契约，直接交给 applyFinishReason（可独立单测，不必每次都经
// assemblePlugins 装配）。
export const finishReasonPlugin: AgentPlugin = (api) => {
  api.hook('onTurnEnd', (ctx, ev) => applyFinishReason(ctx, ev))
}
