// 装配层提供的默认子 agent 档位路由表。
// ---------------------------------------------------------------------------
// core 的 `subagents/tierRouting.ts` 只认识 Pro/Flash 两个抽象档位，具体由哪家 provider 的
// 哪个模型承担这两个档位是装配期决策（M6a 的结论）。这张表就是那份决策：两宿主都还没有单独的
// 差异化配置入口，因此把「未注入时用什么」的默认值收在这里，由 `runtime.ts` 在构造
// `DelegateAgentRuntimeState` 时传入；core 不再持有任何默认值。

import { DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL } from '@einfach-agent/ai'
import type { SubagentTierRouting } from '@einfach-agent/core/subagents'

/** 未显式注入档位路由表时使用的默认表；语义与拆分前写死的 Pro/Flash 映射完全一致。 */
export const DEFAULT_SUBAGENT_TIER_ROUTING: SubagentTierRouting = {
  vendor: 'deepseek',
  models: {
    pro: DEEPSEEK_PRO_MODEL,
    flash: DEEPSEEK_FLASH_MODEL,
  },
}
