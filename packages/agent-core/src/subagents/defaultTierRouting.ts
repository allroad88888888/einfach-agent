// core 内暂存的默认档位路由表。
// ---------------------------------------------------------------------------
// 这是 core 里**唯一**一处出现具体厂商模型名的地方，且只是一个数据常量、没有任何分支逻辑。
// 它留在 core 只为在档位路由契约化（M6a）与装配层接管默认表（M6b）之间保持行为不变；
// M6b 只需把下面这一个常量整体搬到装配层并从注入点传入，core 侧无需再动结构。

import { DEEPSEEK_FLASH_MODEL, DEEPSEEK_PRO_MODEL } from '@web-agent/ai'
import type { SubagentTierRouting } from './tierRouting'

/** 未注入档位路由表时使用的默认表；语义与拆分前写死的 Pro/Flash 映射完全一致。 */
export const DEFAULT_SUBAGENT_TIER_ROUTING: SubagentTierRouting = {
  vendor: 'deepseek',
  models: {
    pro: DEEPSEEK_PRO_MODEL,
    flash: DEEPSEEK_FLASH_MODEL,
  },
}
