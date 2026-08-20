// 主 Agent 的换模型升档：**策略槽** + 把它接到共用判据上的适配器。
// ---------------------------------------------------------------------------
// 判据（「这次往返值不值得换个模型再来一次」）不在这里，在 `@einfach-agent/ai` 的
// modelCapacityEscalation —— 主 Agent 与子 Agent 共用同一条，见那个文件的开头。
// 这里只回答主 Agent 侧的**策略**问题：换不换、换成什么。
//
// 为什么做成槽而不是内置默认：给主 Agent 换模型是**用户没有要求过的行为**——他在会话里选的
// 就是这个模型。子 Agent 不同，它的模型本来就是运行时按档位替用户选的，升一档仍在运行时的
// 授权范围内。所以主 Agent 这一侧默认【不接】：判据照样跑，问到策略时没人应答，run 就按既有
// 方式显式失败（容量终态 → finishReasonPlugin 的中文文案；请求失败 → runToolLoop 的 error）。
// 装配层接上这个槽，才会真的换模型重发一次。

import type { ModelEscalationAsk } from '@einfach-agent/ai'
import type { ModelSettings } from '../state/core.type'

export interface ModelEscalationRequest {
  /** 本次请求实际使用的会话模型设置。 */
  settings: ModelSettings
  /**
   * 触发升档询问的判据结果：容量耗尽时是 provider 自报的那个 finish_reason，
   * 请求整体失败时是 `request_failed`。
   */
  trigger: string
  /** 仅 `request_failed` 时有值：导致这次失败的原始错误。 */
  error?: unknown
}

/** 由装配层注入的主 Agent 升档策略；返回 undefined = 这次不升档。 */
export interface ModelEscalationPolicy {
  escalate(request: ModelEscalationRequest): ModelSettings | undefined | Promise<ModelSettings | undefined>
}

export interface ModelEscalatorInput {
  policy: ModelEscalationPolicy | undefined
  /** 本次请求当前使用的设置（升档后会变，故取函数而不是取值）。 */
  settings(): ModelSettings
  /**
   * 现在重发安全吗。主 Agent 是流式的：一旦有 delta 落成了 assistant 条目，重发会把第二份
   * 正文写进同一个 streamWriter，界面上两段回答叠在一起——这与子 Agent「已执行过工具就不重放」
   * 是同一条理由的流式版本。
   */
  canEscalate(): boolean
  /** 采纳升档：把后续请求切到新设置。 */
  applyEscalation(next: ModelSettings): void
  /** 可观测出口；`escalated` 为 false 时 `reason` 说明为什么没升。 */
  observe(event: { trigger: string; fromModel: string; escalated: boolean; reason?: string; toModel?: string }): void
}

/** 把主 Agent 的策略槽接成共用驱动要的那个升档回调。 */
export function createModelEscalator(input: ModelEscalatorInput): ModelEscalationAsk {
  return async (trigger, error) => {
    if (!input.policy) return false
    const settings = input.settings()
    const fromModel = settings.model
    if (!input.canEscalate()) {
      input.observe({ trigger, fromModel, escalated: false, reason: 'response_already_streamed' })
      return false
    }
    const next = await input.policy.escalate({ settings, trigger, ...(error === undefined ? {} : { error }) })
    if (!next || next.model === settings.model) {
      input.observe({ trigger, fromModel, escalated: false, reason: 'policy_declined' })
      return false
    }
    // 跨厂商换档一律拒绝：档位切换只换 model 这一个字符串，thinking / 采样 / vendorSettings
    // 这些只有本家 adapter 解释得了的参数原样留着，送进另一家会静默失效或直接被拒
    // （与 subagents/tierRouting.ts 的「一张表只服务一个 vendor」是同一条约束）。
    if (next.vendor !== settings.vendor) {
      input.observe({ trigger, fromModel, escalated: false, reason: 'cross_vendor_rejected', toModel: next.model })
      return false
    }
    input.applyEscalation(next)
    input.observe({ trigger, fromModel, escalated: true, toModel: next.model })
    return true
  }
}
