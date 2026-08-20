// 装配层提供的默认子 agent 档位路由：按会话 vendor 取表。
// ---------------------------------------------------------------------------
// core 的 `subagents/tierRouting.ts` 只认识 Pro/Flash 两个抽象档位，具体由哪家 provider 的
// 哪个模型承担这两个档位是装配期决策（M6a 的结论）。这里是那份决策的判定面：表本身住
// `defaultTierRoutingTable.ts`，`runtime.ts` 构造 `DelegateAgentRuntimeState` 时按会话 vendor
// 取一张传进去；core 仍不持有任何默认值。
//
// 为什么按会话 vendor 取表、而不是把多家拼进一张表（`tierRouting.ts` 原本担心的那件事）：
// 换档在实现上只替换 `settings.model` 一个字符串，会话其余参数原样保留——而其中
// `vendorSettings` 是只有本家 adapter 解释得了的不透明袋（deepseek/glm 的 reasoning_effort、
// kimi 的 region），thinking/temperature/max_tokens 各家的接受度也不同。一张跨厂商拼起来的表
// 会把 A 家的这些参数原封不动送进 B 家的请求，静默失效或直接 400。按会话 vendor 取表把换档
// 永远关在同一家内部，那份担心就不成立；`supportsSubagentTierRouting` 仍会先比 vendor 再比
// SKU，所以即便有人注入了别家的表，也只会退回父模型，换不出别家的模型。

import type { ModelSettings } from '@einfach-agent/core'
import type { SubagentTierRouting } from '@einfach-agent/core/subagents'
import { DEFAULT_TIER_ROUTING_TABLES } from './defaultTierRoutingTable'

/**
 * 「这家 provider 没有档位阵容」时用的表。
 *
 * vendor 取一个任何 provider registry 都注册不出来的 id（带空格与括号），于是
 * `supportsSubagentTierRouting` 在第一步的 vendor 比对就必然失败：会话留在保守档、继续用父
 * 会话已配置的模型，`runLowCostExtraction` 也不挂载。`models` 两档因此永远读不到，留空串。
 * 这条路径在 `routeSubagentModel` 里记 `unrouted_provider_uses_parent_model`——正是它字面
 * 表达的那件事，也正是按 vendor 拆表之前 GLM/Kimi/openai-compat 会话得到的裁决。
 */
export const UNROUTED_TIER_ROUTING: SubagentTierRouting = {
  vendor: '(no tier lineup)',
  models: {
    pro: '',
    flash: '',
  },
}

/** 按会话 vendor 取默认档位表；这家没有阵容时返回不覆盖任何会话的 `UNROUTED_TIER_ROUTING`。 */
export function defaultSubagentTierRouting(
  vendor: ModelSettings['vendor'],
): SubagentTierRouting {
  // 精确匹配，不做大小写归一：core 把 vendor 当不透明 id、只做相等比较，这里多归一一步会让
  // 「表里有这家」与「supportsSubagentTierRouting 认这家」两个判断错位——取到了表却因为大小写
  // 对不上而恒不生效，比取不到表更难查。
  return DEFAULT_TIER_ROUTING_TABLES.get(vendor) ?? UNROUTED_TIER_ROUTING
}
