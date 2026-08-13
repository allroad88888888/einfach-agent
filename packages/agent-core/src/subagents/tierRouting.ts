// 子 agent 档位路由契约。
// ---------------------------------------------------------------------------
// core 只认识 Pro / Flash 两个**抽象档位**：Pro 是保守档，Flash 是低价档，哪些任务有资格用
// Flash 由 routing.ts 的纯规则决定。至于「这两个档位各由哪家 provider 的哪个模型承担」，
// 属于装配期决策，必须由外部注入 —— core 里不得写死任何厂商模型名。

import type { ModelSettings } from '../state/core.type'
import type { SubagentModelTier } from './types'

/**
 * 一张档位路由表：把抽象档位映射到**同一家 provider** 的具体模型。
 *
 * 为什么 vendor 收在表级、而不是每个档位各带一个 vendor：`ModelSettings` 是按 vendor 判别的
 * 联合类型（各家有各自的 reasoning_effort / thinking 等特化字段），跨 vendor 换档位无法保留
 * 其余会话参数；档位切换在实现上只换 model 这一个字符串。要同时支持多家，就按会话 vendor
 * 选用不同的表，而不是把一张表拼成跨厂商的组合。
 */
export interface SubagentTierRouting {
  /**
   * 这张表服务的 vendor id。类型跟随 core 现有的 vendor 域；core 只对它做相等比较，
   * 不解释取值，也不为任何具体取值写分支。
   */
  vendor: ModelSettings['vendor']
  /** 档位 → 该 vendor 下承担这个档位的模型 id。 */
  models: Readonly<Record<SubagentModelTier, string>>
}

/** 档位对应的具体模型目标；需要 vendor 与 model 成对信息的调用方用它，避免各自拼装。 */
export function subagentTierTarget(
  routing: SubagentTierRouting,
  tier: SubagentModelTier,
): { vendor: SubagentTierRouting['vendor']; model: string } {
  return { vendor: routing.vendor, model: routing.models[tier] }
}

/**
 * 会话配置的模型是否正好是这张表里的某个档位 SKU。
 *
 * 只有它成立时档位路由才允许替换模型：私有网关和表外的自定义模型名不假定实现了同样的档位，
 * 一律保留父会话已配置的模型。运行时的低价抽取能力也用这同一个判据决定要不要开放，
 * 两条路径共用一份资格定义。
 */
export function supportsSubagentTierRouting(
  settings: ModelSettings,
  routing: SubagentTierRouting,
): boolean {
  if (settings.vendor !== routing.vendor) return false
  return Object.values(routing.models).includes(settings.model)
}

/** 按档位改写父会话设置里的模型；会话不在表覆盖范围内时**原样返回**父设置。 */
export function applySubagentTier(
  settings: ModelSettings,
  tier: SubagentModelTier,
  routing: SubagentTierRouting,
): ModelSettings {
  if (!supportsSubagentTierRouting(settings, routing)) return settings
  return { ...settings, model: routing.models[tier] }
}
