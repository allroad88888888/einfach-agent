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

import type { ModelItem, ModelResponseMessage } from '@web-agent/ai'
import { isAbnormalFinishReason, type AbnormalFinishReason } from '../finishReason'
import type { TraceAttributes } from '../../observability/port'
import type { CompletedToolResult, ToolResultPatch } from '../toolResultPatch'
import type { CoreCtx } from './coreCtx'

// 简介：组请求时的可变投影（压缩改这，不写回 store）。
// 详情：transformContext / prepareRequest 就地改 draft.messages —— 它只是「本轮请求体」的一次性
//   投影，绝不写回 itemsAtom（itemsAtom 是唯一真相源，写回会永久破坏历史 / 让 revert 拿到被摘要过
//   的快照）。draft 的可变对象由 loop 在组请求前建、hook 链跑完后喂给 provider。
export interface RequestDraft {
  messages: ModelItem[]
}

// 简介：插件可观察到的、已通过 gate 和 schema 校验的工具调用。
// 详情：args 是执行参数的不可变快照；插件不能通过修改它影响真正的工具执行。
export interface ToolCallEvent {
  readonly callId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface BeforeToolCallEvent extends ToolCallEvent {}

// 简介：beforeToolCall 的拦截返回。
// 详情：block:true → 拦下这次工具执行（reason 供留痕 / 回给 model）。返回 undefined 或 block 非真
//   → 放行。fan-out 语义：按注册序，第一个返回 {block:true} 的胜、短路。
export interface BeforeToolCallResult {
  block?: boolean
  reason?: string
}

// 简介：afterToolCall 收到的瞬时事件。
// 详情：只暴露已完成的成功/失败结果；pause 是 loop 内部控制流，不会进入插件边界。
export interface AfterToolCallEvent extends ToolCallEvent {
  readonly result: CompletedToolResult
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

// 简介：shouldStop 的显式终止决定。
// 详情：该槽只允许正常停止；等待用户输入/确认/计划审批必须由 tool loop 写入对应 pending 状态，
// 不能借由一个泛化的 stop 决定伪造。checkpoint 与 runStatus 一起固定，供消费方原子地结束本轮。
export interface ShouldStopDecision {
  readonly stop: true
  readonly runStatus: 'stopped'
  readonly reason: string
  readonly checkpoint: {
    readonly kind: 'stopped'
  }
}

// 简介：shouldStop 返回值不符合协议时抛出的错误。
// 详情：插件可来自未类型检查的运行时边界；拒绝旧 boolean 或不完整对象，避免 loop 猜测终止语义。
export class ShouldStopDecisionValidationError extends Error {
  constructor(message: string) {
    super(`Invalid shouldStop decision: ${message}`)
    this.name = 'ShouldStopDecisionValidationError'
  }
}

function isDecisionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 简介：校验 shouldStop 的运行时返回值。
// 详情：undefined 是唯一的继续信号；所有终止必须带齐 stopped 状态、非空原因和 stopped checkpoint。
export function validateShouldStopDecision(value: unknown): ShouldStopDecision | undefined {
  if (value === undefined) return undefined

  if (typeof value === 'boolean') {
    throw new ShouldStopDecisionValidationError('boolean results are not supported')
  }
  if (!isDecisionRecord(value)) {
    throw new ShouldStopDecisionValidationError('result must be a decision object or undefined')
  }
  if (value.stop === false) {
    throw new ShouldStopDecisionValidationError('stop:false is not supported; return undefined to continue')
  }
  if (value.stop !== true) {
    throw new ShouldStopDecisionValidationError('stop must be true')
  }
  if (value.runStatus !== 'stopped') {
    throw new ShouldStopDecisionValidationError('runStatus must be stopped')
  }
  const reason = value.reason
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ShouldStopDecisionValidationError('reason must be a non-empty string')
  }
  if (!isDecisionRecord(value.checkpoint) || value.checkpoint.kind !== 'stopped') {
    throw new ShouldStopDecisionValidationError('checkpoint.kind must be stopped')
  }

  return {
    stop: true,
    runStatus: 'stopped',
    reason,
    checkpoint: { kind: 'stopped' },
  }
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

// 判据与文案的定义已搬到中立的 runtime/finishReason.ts（盘点 E2）：loop、插件、子 Agent 与
// packages/subagents 都消费它，不该从「turn-end 契约」或「默认插件」里深挖。turn-end 契约仍
// 原样转出判据与类型，插件作者的 import 面不变。
export type { AbnormalFinishReason } from '../finishReason'
export { isAbnormalFinishReason } from '../finishReason'

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
  /** 工具执行后（改写结果 / 记录挂这，Stage 2）。只能返回可验证的结果补丁。 */
  afterToolCall?(
    ctx: CoreCtx,
    ev: AfterToolCallEvent,
  ): ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>
  /** 一轮结束（finish_reason 三态 / 循环检测挂这，Stage 2a）。返回完整 TurnEndStopDecision 可要求
   *  loop 带状态终止 run；返回 void / TurnEndContinueDecision = 不干预、loop 继续。 */
  onTurnEnd?(
    ctx: CoreCtx,
    ev: TurnEndEvent,
  ): void | TurnEndDecision | Promise<void | TurnEndDecision>
  /** 本轮结束后是否显式停止。undefined 继续；决定必须通过 validateShouldStopDecision 运行时校验。 */
  shouldStop?(
    ctx: CoreCtx,
    ev: TurnEndEvent,
  ): ShouldStopDecision | undefined | Promise<ShouldStopDecision | undefined>
}
