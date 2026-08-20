// 换模型升档的【单一判据】+ 一次性升档驱动。
// ---------------------------------------------------------------------------
// 这里回答两个问题，且只回答这两个：
//   ① 这次模型往返的结果，值不值得**换一个模型**再发一次？
//   ② 值得的话，怎么发那唯一的一次（谁来换、换成什么，本模块不管）。
// 「换成什么」是策略，由调用方各自决定：子 Agent 按档位路由表升到 Pro，主 Agent 由装配层
// 经 `RuntimeConfig.modelEscalation` 决定（默认不接 = 不升档）。判据共用、策略可配。
//
// ── 为什么落在 agent-ai，而不是 agent-core/runtime ──
//   · 「容量耗尽」是 provider 私有终态。判据原先写在 core 的 subagents/modelSelection.ts 里，
//     直接比对 `'insufficient_system_resource'` 这个 DeepSeek 私有字面量——core 认识某一家的
//     终态，正是 finishReasonExtensions 这套注册表要消掉的东西。改成问注册表
//     （`capacityExhausted`）之后，判据必须住在注册表这一侧。
//   · 「确定性 4xx 不值得换模型」解析的那句状态前缀，是本包 modelRetry.ts 的 summarizeHttpError
//     亲手拼的（那行注释写着「Keep the historical status prefix: Core uses it to avoid
//     escalating deterministic 4xx failures」）。生产方与判定方隔包相望时，这条前缀契约只靠
//     一句注释维系；同包相邻则改一处必然看见另一处。
//   · 主循环（runtime/）与子 Agent（subagents/）都已依赖本包，放这里两边平等取用；放进
//     core 的任一子目录都得让另一侧跨目录深引，且 core 内部 runtime ← subagents 的既有方向
//     会被反向依赖压弯。

import { finishReasonExtensionFor } from './finishReasonExtensions'
import type { ModelChatResponse } from './modelProtocol'
import { isAbortError } from './modelRetry'

/** 请求整体失败（非确定性 4xx、非中止）时的触发标识；容量耗尽时用实际的 finish_reason。 */
export const MODEL_ESCALATION_REQUEST_FAILED = 'request_failed'

/**
 * 判据成立时被问一次的升档回调。
 * 返回 true = 调用方已切到替代模型，驱动会**再发一次且仅一次**；false = 不升档，原样收尾。
 */
export type ModelEscalationAsk = (trigger: string, error?: unknown) => Promise<boolean>

/** 确定性失败：换模型也一样会被拒（参数非法 / 未授权 / 余额不足 / 实体不可处理）。 */
const DETERMINISTIC_REQUEST_STATUSES = new Set([400, 401, 402, 422])
const HTTP_STATUS_PREFIX = /^Chat completion returned (\d{3})(?:\b|:)/

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'unknown error'
}

function isDeterministicRequestError(error: unknown): boolean {
  const match = HTTP_STATUS_PREFIX.exec(toErrorMessage(error))
  return match ? DETERMINISTIC_REQUEST_STATUSES.has(Number(match[1])) : false
}

/** 这条响应带没带模型真正产出的东西（正文 / 推理 / 工具调用）。 */
function carriesAssistantPayload(response: ModelChatResponse): boolean {
  const message = response.choices?.[0]?.message
  return (
    (typeof message?.content === 'string' && message.content.length > 0)
    || (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0)
    // 原始存在性才是判据：畸形的 tool_calls 也是模型已经产出的东西，不能因为运行时收窄后
    // 派发不了就当没发生过、拿另一个模型重放一遍。
    || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
  )
}

/** 这个 finish_reason 是不是某家 provider 自报的「容量耗尽」终态；是则原样返回它。 */
export function capacityExhaustedFinishReason(reason: string | null | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined
  return finishReasonExtensionFor(reason)?.capacityExhausted === true ? reason : undefined
}

/**
 * 响应侧判据：容量耗尽且**一个字都没产出**时才值得换模型。
 * 成立时返回触发它的 finish_reason（供调用方原样记账），否则 undefined。
 */
export function modelResponseWarrantsEscalation(response: ModelChatResponse): string | undefined {
  const trigger = capacityExhaustedFinishReason(response.choices?.[0]?.finish_reason)
  if (trigger === undefined) return undefined
  return carriesAssistantPayload(response) ? undefined : trigger
}

/**
 * 错误侧判据：请求整体失败时，除**中止**与**确定性 4xx** 之外都值得换模型试一次。
 * 中止是用户意图，确定性 4xx 换谁都一样被拒——两者升档都只是白烧一次调用。
 */
export function modelErrorWarrantsEscalation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || isAbortError(error)) return false
  return !isDeterministicRequestError(error)
}

/**
 * 发一次模型请求；判据成立且升档回调点头时，换模型**重发一次**（至多一次，由本函数保证：
 * 这里没有循环，第二次的结果无条件返回/抛出）。
 * `invoke` 每次都重新读调用方当前的设置——升档回调改完设置，紧接着那次 invoke 就用新模型。
 */
export async function callWithModelEscalation(args: {
  invoke(): Promise<ModelChatResponse>
  escalate: ModelEscalationAsk
  signal?: AbortSignal
}): Promise<ModelChatResponse> {
  try {
    const response = await args.invoke()
    const trigger = modelResponseWarrantsEscalation(response)
    if (trigger === undefined) return response
    return await args.escalate(trigger) ? args.invoke() : response
  } catch (error) {
    if (!modelErrorWarrantsEscalation(error, args.signal)) throw error
    if (!await args.escalate(MODEL_ESCALATION_REQUEST_FAILED, error)) throw error
    return args.invoke()
  }
}
