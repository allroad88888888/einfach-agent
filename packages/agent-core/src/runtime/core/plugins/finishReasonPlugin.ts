// finish_reason 异常三态插件（Core 抽离 Stage 2a）—— 把 modelRun.ts 内联的「finish_reason 三态
// 收尾」抽成 onTurnEnd 插件。
// ---------------------------------------------------------------------------
// 契约：docs/core-plugin-extraction-blueprint.md §四/§五（PX3 LoopHooks；「finish_reason 三态 →
//   finishReasonPlugin → onTurnEnd」那一行）。本文件只搬这一个关注点。
// 【最高铁律】纯结构搬迁，行为零变化：条目正文（含系统标注文案逐字）、run 收成 error、
//   commit/落盘、trace 都必须与搬迁前逐字一致。三份文案常量原样从 modelRun.ts 搬来（一字未改）。
//
// ── 关注点原貌（modelRun.ts 的 runToolLoop，回填工具结果那一步之前）──
//   一轮 model 往返收尾，若 finish_reason ∈ {length, content_filter, insufficient_system_resource}
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
// 【本插件只负责】：① 判定 finish_reason 是否异常三态（isAbnormalFinishReason）；② 产出对应中文
//   notice 文案（沿用三份常量的逐字内容）；③ 仅在【没有流式条目】时（Case B，非流式响应）通过
//   ctx.store.setter 往 itemsAtom【追加】那条「系统标注」条目（对应旧代码 `if (!streamWriter.hasItem()
//   && isCurrentRun) appendItem(...)` 那一段）；④ 返回 TurnEndDecision { stop, runStatus, reason }。
// 【loop / 集成 agent 收到 decision 后负责】：setContextStats / commit checkpoint（带
//   FINISH_REASON_LABEL_TAGS 前缀，该常量【不搬】、留在 modelRun.ts）/ persist / patchRun status /
//   finishTrace('agent.finish_abnormal') / 退出。即「条目内容插件写，run 收尾 loop 做」。
//
// ── 移走的符号（原先定义在 modelRun.ts，集成 agent 会改成从本文件 import）──
//   AbnormalFinishReason（type）/ FINISH_REASON_ERRORS / FINISH_REASON_ITEM_NOTICES /
//   FINISH_REASON_STANDALONE_NOTICES / isAbnormalFinishReason（旧代码是内联 `reason==='length' ||
//   'content_filter' || 'insufficient_system_resource'` 的三连或，本文件收拢成具名类型守卫）。
//   FINISH_REASON_LABEL_TAGS【不搬】——它只在 loop 侧 commitTurn 的 label 前缀用，留在 modelRun.ts，
//   由 modelRun 从本文件 import AbnormalFinishReason 给它做 Record 键类型。

import { itemsAtom } from '../../../state/sessionAtoms'
import type { ConversationItem } from '../../../state/core.type'
import type { AssistantItem, ModelResponseMessage } from '@web-agent/ai'
import { newId } from '../../newId'
import type { CoreCtx } from '../coreCtx'
import type { TurnEndDecision, TurnEndEvent } from '../loopHooks'
import type { AgentPlugin } from '../pluginApi'

// ---------------------------------------------------------------------------
// finish_reason 异常三态（原样从 modelRun.ts 搬来，type + 三份文案常量一字未改）
// ---------------------------------------------------------------------------
export type AbnormalFinishReason = 'length' | 'content_filter' | 'insufficient_system_resource'

// finish_reason 异常三态的用户可见文案（同一份也回给 model / 进 trace，口径唯一）。
export const FINISH_REASON_ERRORS: Record<AbnormalFinishReason, string> = {
  length: '模型输出触顶被截断（finish_reason=length），本轮回复不完整；请调高 max_tokens 或让模型分段输出',
  content_filter: '模型输出被内容安全策略拦截（finish_reason=content_filter）',
  insufficient_system_resource: '模型服务容量不足（finish_reason=insufficient_system_resource），请稍后重试',
}

// ---------------------------------------------------------------------------
// 截断标记的持久化（finish_reason 异常三态）
// ---------------------------------------------------------------------------
// 承载 finishError 的 runAtom【不持久化】（设计如此），而被掐断的半截 assistant 条目是照常
// 进 checkpoint 并落盘的 —— 两者一分家就出两个坑：
//   a) 刷新之后那半截回答在历史里与一条正常回复完全同形，用户看不出模型是被 max_tokens 掐断的；
//   b) 更要紧：这条半截文本会作为历史【在之后每一轮被重发给模型】，模型同样看不到「上文这里
//      被截断过」，很可能把半截推理当成已成立的结论继续往下走。
// 故截断状态必须成为【持久化数据本身】的一部分，落点选在 assistant 条目正文末尾：
//   · 正文是唯一同时进 itemsAtom → checkpoint → 落盘 → 且每轮原样重发给模型的载体，一处改动
//     同时满足 a 和 b。换成 ConversationItem 上的新字段只能满足 a（该字段不进线协议、模型看不见）；
//     换成 assistant 条目内的新字段则会被原样发进 OpenAI 兼容请求体，属于协议外字段，不能碰。
//   · 只在异常三态分支追加，正常轮的条目一个字都不动（不污染）。
//   · revert 语义不变：标注是 items 快照的一部分，回到这一轮就带着标注、回到更早的轮就没有。
export const FINISH_REASON_ITEM_NOTICES: Record<AbnormalFinishReason, string> = {
  length:
    '\n\n> ⚠️ 【系统标注】以上回复因触达输出上限被截断（finish_reason=length），内容不完整。' +
    '其中的推理很可能只进行到一半，不要把它当作已成立的结论直接沿用。',
  content_filter:
    '\n\n> ⚠️ 【系统标注】以上回复被内容安全策略拦截（finish_reason=content_filter），内容不完整。',
  insufficient_system_resource:
    '\n\n> ⚠️ 【系统标注】以上回复因模型服务容量不足而中断（finish_reason=insufficient_system_resource），内容不完整。',
}

// 「仅含标注」独立条目专用文案 —— 与上面那份【分开】，因为「以上」的指代对象不同。
// 上面那份是拼在正文【之后】的，「以上回复」指同一条消息里前面那段文字，成立；
// 而 content_filter / insufficient_system_resource 在非流式下 content 恒为空，标注要单独成条，
// 此时它上面一条消息是【用户的提问】—— 再说「以上回复」就指到用户身上了。
// 重发历史时模型看到 user → assistant('以上回复被拦截')，很可能理解成「用户的输入被拦截了」，
// 与「让模型知道自己上一轮输出出了什么事」的目标正好相反，所以主语必须换成「本轮回复」。
export const FINISH_REASON_STANDALONE_NOTICES: Record<AbnormalFinishReason, string> = {
  length:
    '> ⚠️ 【系统标注】本轮回复因触达输出上限被截断（finish_reason=length），未产生任何内容。',
  content_filter:
    '> ⚠️ 【系统标注】本轮回复被内容安全策略拦截（finish_reason=content_filter），未产生任何内容。',
  insufficient_system_resource:
    '> ⚠️ 【系统标注】本轮回复因模型服务容量不足而中断（finish_reason=insufficient_system_resource），未产生任何内容。',
}

// 简介：finish_reason 是否落在异常三态。旧代码里是内联的三连或（reason==='length' ||
//   'content_filter' || 'insufficient_system_resource'），这里收拢成具名类型守卫，收窄到
//   AbnormalFinishReason 后即可安全索引上面三份 Record（也供 loop 侧选 finalize 变体 / 取 label）。
export function isAbnormalFinishReason(reason: string | null): reason is AbnormalFinishReason {
  return (
    reason === 'length' ||
    reason === 'content_filter' ||
    reason === 'insufficient_system_resource'
  )
}

// modelRun.ts 里同名私有 helper 的逐字复制（含 reasoning_content / tool_calls 处理）。不从
// modelRun.ts import（会成环——modelRun 要反过来 import 本插件），孤立成本可忽略，换来插件对
// modelRun 零依赖。本插件补条目只用「2 参」形态（不传 toolCalls），但完整复制保证与旧代码
// assistantItemFromMessage(msg, noticeContent) 逐字同构（msg.reasoning_content 照样带过来）。
function assistantItemFromMessage(
  msg: ModelResponseMessage | undefined,
  content: string | null,
  toolCalls?: AssistantItem['tool_calls'],
): AssistantItem {
  const item: AssistantItem = {
    role: 'assistant',
    content,
  }
  const reasoningContent = msg?.reasoning_content
  if (reasoningContent) item.reasoning_content = reasoningContent
  if (toolCalls && toolCalls.length > 0) item.tool_calls = toolCalls
  return item
}

// 简介：TurnEndEvent 的私有扩展字段——本插件与 loop 的协作契约（见文件头「关键分工」）。
// 详情：LoopHooks（上游契约，不可改）里 TurnEndEvent 只有 { finishReason, toolCalls }；补条目
//   （Case B）还需要两样「此刻还没进 store」的瞬时数据：本轮非流式响应的 assistant message、
//   以及流式期间是否已建过条目。故在插件自己的文件里扩展、loop 侧按需 `as FinishReasonTurnEndEvent`
//   使用，不改动 core 的公共类型（与 compactionPlugin 的 CompactionRequestDraft 同款做法）。
export interface FinishReasonTurnEndEvent extends TurnEndEvent {
  /** 本轮非流式响应的 assistant message（补条目时取 content / reasoning_content）。省略视作无内容。 */
  msg?: ModelResponseMessage
  /**
   * 流式期间是否已 append 过 assistant 条目（= 旧代码 streamWriter.hasItem()）。
   *   · true（Case A）：系统标注已由 loop 侧的 streamWriter.finalize(msg, undefined, notice) 追加，
   *     本插件【跳过】补条目，避免出现两条重复回复。
   *   · false / 省略（Case B，非流式响应）：本插件补一条「系统标注」assistant 条目。
   */
  hasStreamedItem?: boolean
}

// 简介：finish_reason 三态收尾本体——从 modelRun.ts 的 runToolLoop 内联代码逐字搬来（异常分流那段）。
// 详情：非异常三态 → 返回 undefined（不干预，loop 继续）。length+有 tool_calls 是可恢复截断
//   （不在此终止，留给坏 JSON 闸门）→ 同样返回 undefined。其余异常态：仅在无流式条目时补一条
//   系统标注 assistant 条目（ctx.store 裸 setter，PX4；`ctx.isCurrent()` 对应旧 isCurrentRun 守卫，
//   短路顺序与旧代码 `!hasItem() && isCurrentRun` 一致），并返回 { stop, runStatus:'error', reason }。
export function applyFinishReason(
  ctx: CoreCtx,
  ev: FinishReasonTurnEndEvent,
): TurnEndDecision | undefined {
  const finishReason = ev.finishReason
  // 非异常三态（stop / tool_calls / null / …）→ 不干预。
  if (!isAbnormalFinishReason(finishReason)) return undefined
  // length + 有 tool_calls：arguments JSON 极可能是半截的，可恢复——【不】在此终止（终止会留下
  // 没有结果的 tool_calls）。放行给 loop 后续逐个 tool_call 的参数解析（坏 JSON 闸门）。
  // content_filter / insufficient_system_resource 恒终止（与旧 `else if` 分支逐字等价：旧代码
  // 第一个 if 只拦 length+tool_calls，故这两态无论 toolCalls 多少都落进终止分支）。
  if (finishReason === 'length' && ev.toolCalls.length > 0) return undefined

  const finishError = FINISH_REASON_ERRORS[finishReason]
  const finishNotice = FINISH_REASON_ITEM_NOTICES[finishReason]

  // 非流式响应下 streamWriter 没建过条目，这里补一条纯文本的，让用户看得见断在哪 ——
  // content_filter / insufficient_system_resource 按定义 content 为空，assistantHasContent
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
    // PX4 裸 setter：不可变追加（[...prev, item]，与 appendItem 同形），不经 guarded-writer。
    // 会话存在性由上面的 ctx.isCurrent() 覆盖（旧 appendItem 的 ghost guard 在此为冗余）。
    const noticeItem: ConversationItem = {
      id: newId(),
      createdAt: Date.now(),
      item: assistantItemFromMessage(msg, noticeContent),
    }
    ctx.store.setter(itemsAtom, (prev) => [...prev, noticeItem])
  }

  // 条目内容插件写完，run 收尾（commit checkpoint 落盘 + patchRun status:'error' + 退出）交给
  // loop：stop 要求本轮后终止 run，runStatus:'error' 是异常收尾，reason 即 finishError（供 loop
  // 的 patchRun error / finishTrace）。
  return { stop: true, runStatus: 'error', reason: finishError }
}

// 简介：finish_reason 三态插件（PX2 AgentPlugin）——装配期把 applyFinishReason 注册进 onTurnEnd 槽。
// 详情：TurnEndEvent 到 FinishReasonTurnEndEvent 的 cast 在这里做一次，其余逻辑全在
//   applyFinishReason 里（可独立单测，不必每次都经 assemblePlugins 装配）。
export const finishReasonPlugin: AgentPlugin = (api) => {
  api.hook('onTurnEnd', (ctx, ev) => applyFinishReason(ctx, ev as FinishReasonTurnEndEvent))
}
