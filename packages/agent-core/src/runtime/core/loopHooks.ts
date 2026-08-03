// 薄 loop 的 hook 槽 LoopHooks（PX3）—— 单槽 hook；插件层 fan-out 成多订阅。
// ---------------------------------------------------------------------------
// 契约（core-plugin-extraction-blueprint §四 PX3）：每个槽收 CoreCtx +「此刻还没进 store 的
//   瞬时数据」。关键差异：这些槽里【看不到穿进来的状态】—— items/run/checkpoints/meta 全靠
//   ctx.store.getter(...) / ctx.root.getter(...) 现取。这是「状态核心最强」的落地。
//
// Stage 1（立缝）只有 transformContext 被真正接进 loop（压缩挂它）；其余槽先把类型定死、留着
// 后续搬。Stage 2a（本轮）在缝上【additive】加两样能力形状：onRunStart 槽（run 启动归一化）+
// onTurnEnd 的 TurnEndDecision 终止返回（finish_reason 三态 / 循环检测用它「带状态终止 run」），
// 供 modelRun 那侧把「模型迁移 / finish_reason / 循环检测」三个关注点搬成插件——loop 的实际接线
// 不在本文件（本文件只定义槽形状）。危险工具确认 / ask_user 暂停留到 Stage 2b，原样待在 loop 里。
// 定义但不强制实现 —— assemblePlugins 会把每个槽按 fan-out 语义合成，loop 侧据「槽为 undefined」跳过。

import { finishReasonExtensionFor, type ModelItem, type ModelResponseMessage } from '@web-agent/ai'
import type { TraceAttributes } from '../../observability/types'
import type { CoreCtx } from './coreCtx'

// 简介：组请求时的可变投影（压缩改这，不写回 store）。
// 详情：transformContext / prepareRequest 就地改 draft.messages —— 它只是「本轮请求体」的一次性
//   投影，绝不写回 itemsAtom（itemsAtom 是唯一真相源，写回会永久破坏历史 / 让 revert 拿到被摘要过
//   的快照）。draft 的可变对象由 loop 在组请求前建、hook 链跑完后喂给 provider。
export interface RequestDraft {
  messages: ModelItem[]
}

// 简介：beforeToolCall 收到的瞬时事件。
// 详情：toolCall / args 都是 unknown —— core 不认识具体工具形状，交由插件自行收窄。
export interface BeforeToolCallEvent {
  toolCall: unknown
  args: unknown
}

// 简介：beforeToolCall 的拦截返回。
// 详情：block:true → 拦下这次工具执行（reason 供留痕 / 回给 model）。返回 undefined 或 block 非真
//   → 放行。fan-out 语义：按注册序，第一个返回 {block:true} 的胜、短路。
export interface BeforeToolCallResult {
  block?: boolean
  reason?: string
}

// 简介：afterToolCall 收到的瞬时事件。
// 详情：result 是「到此为止的工具结果」（多个 afterToolCall 串成改写管道时，是上一环合并后的累积值）。
export interface AfterToolCallEvent {
  toolCall: unknown
  result: unknown
}

// 简介：onTurnEnd 收到的完整瞬时事件（一轮 model 往返结束）。
// 详情：这份事件是 loop 与终止插件唯一共享的 turn-end 契约。所有字段均由 loop 在调用 hook 前算好，
// 插件不能再私有扩展或在边界做断言，避免两份谓词与字段可选性漂移。
export interface TurnEndEvent {
  finishReason: string | null
  toolCalls: unknown[]
  assistantHasContent: boolean
  msg: ModelResponseMessage | undefined
  hasStreamedItem: boolean
}

// 简介：onTurnEnd 的完整终止决策（Stage 2a）—— 插件看完一轮后可要求 loop【带状态终止 run】。
// 详情：finish_reason 异常收尾、循环检测都用它。stop:true 是唯一的终止开关，且终止路径必须带齐
// run 状态、原因与 trace 事件名；loop 直接消费它们，不再补默认值。
export interface TurnEndStopDecision {
  stop: true
  runStatus: 'error' | 'stopped'
  reason: string
  traceEventName: string
  traceAttrs?: TraceAttributes
}

// 简介：onTurnEnd 的非终止返回形状。
// 详情：保留 { stop:false } / {} 给观察型插件使用；assemblePlugins 会继续 fan-out，不把它交给 loop。
export interface TurnEndContinueDecision {
  stop?: false
  reason?: string
}

export type TurnEndDecision = TurnEndStopDecision | TurnEndContinueDecision

export type AbnormalFinishReason = string

// 简介：finish_reason 是否需要异常终止。
// 详情：标准异常原因和 provider extension 都由同一守卫收敛，避免 loop 与插件各自维护判据。
export function isAbnormalFinishReason(reason: string | null): reason is AbnormalFinishReason {
  return (
    reason === 'length' ||
    reason === 'content_filter' ||
    finishReasonExtensionFor(reason) !== undefined
  )
}

// 简介：取本轮需要异常终止的 finish_reason。
// 详情：length + tool_calls 是可恢复的半截工具参数，不终止，留给坏 JSON 闸门；其余异常原因终止。
export function getAbnormalFinishReason(
  ev: Pick<TurnEndEvent, 'finishReason' | 'toolCalls'>,
): AbnormalFinishReason | undefined {
  const { finishReason, toolCalls } = ev
  return isAbnormalFinishReason(finishReason) && !(finishReason === 'length' && toolCalls.length > 0)
    ? finishReason
    : undefined
}

// 简介：薄 loop 的单槽 hook 集合（PX3）。
// 详情：每个槽可选；无人注册时 assemblePlugins 产出 undefined，loop 侧据此跳过。带返回值的槽
//   即拦截型（beforeToolCall/afterToolCall/shouldStop），其余为变换 / 观察型。
export interface LoopHooks {
  /** run 开始、第一轮请求之前调一次（模型迁移把迁移后 settings 归一化写进 sessionsAtom 挂这，Stage 2a）。 */
  onRunStart?(ctx: CoreCtx): void | Promise<void>
  /** 组请求前变换上下文（压缩挂这）。就地改 draft.messages；状态从 ctx.store 读，不穿 messages。 */
  transformContext?(ctx: CoreCtx, draft: RequestDraft): void | Promise<void>
  /** 发请求前再改一次投影（模型迁移挂这，Stage 2）。 */
  prepareRequest?(ctx: CoreCtx, draft: RequestDraft): void | Promise<void>
  /** 工具执行前（schema 校验 / 确认门 / 危险门挂这，Stage 2）。返回 {block:true} 拦截。 */
  beforeToolCall?(
    ctx: CoreCtx,
    ev: BeforeToolCallEvent,
  ): BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>
  /** 工具执行后（改写结果 / 记录挂这，Stage 2）。返回值按字段覆盖合并进结果。 */
  afterToolCall?(ctx: CoreCtx, ev: AfterToolCallEvent): unknown
  /** 一轮结束（finish_reason 三态 / 循环检测挂这，Stage 2a）。返回完整 TurnEndStopDecision 可要求
   *  loop 带状态终止 run；返回 void / TurnEndContinueDecision = 不干预、loop 继续。 */
  onTurnEnd?(
    ctx: CoreCtx,
    ev: TurnEndEvent,
  ): void | TurnEndDecision | Promise<void | TurnEndDecision>
  /** 是否在本轮后优雅停（ask_user / plan 审批挂这，Stage 2）。任一返回 true 即停。 */
  shouldStop?(ctx: CoreCtx): boolean | Promise<boolean>
}
