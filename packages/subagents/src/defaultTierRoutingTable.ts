// 内置 provider 的默认子 agent 档位表：数据本身，以及逐家「凭什么是这两个 SKU」。
// ---------------------------------------------------------------------------
// 判定住 `defaultTierRouting.ts`（按会话 vendor 取哪张表、取不到怎么办），这里只放表与理由。
// 分家的理由与 `scripts/state-invariants/atomDispositionTable.js` 一致：表随厂商阵容变动，
// 判定不变；改档位的人只需要读这一个文件。
//
// 硬约束：表里出现的每个模型名都必须在 `@einfach-agent/ai` 的厂商能力描述表
// （`vendorDescriptorFor(vendor).models`，数据在 builtinProviders.ts）里有条目。凭记忆写一个
// 不存在的模型名不会报错，只会让整张表**静默失效**——会话模型对不上表内 SKU 时
// `supportsSubagentTierRouting` 返回 false，档位路由整个退回父模型。
// `defaultTierRouting.test.ts` 拿能力表逐条比对，钉住这条。

import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  DEEPSEEK_VENDOR_ID,
  DEFAULT_GLM_MODEL,
  DEFAULT_KIMI_MODEL,
  GLM_FLASH_MODEL,
  GLM_VENDOR_ID,
  KIMI_VENDOR_ID,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'
import type { SubagentTierRouting } from '@einfach-agent/core/subagents'

// DeepSeek：V4 的两个 SKU 正好就是两个档位，逐字沿用按 vendor 拆表之前的唯一一张表。
const DEEPSEEK_TIER_ROUTING: SubagentTierRouting = {
  vendor: DEEPSEEK_VENDOR_ID,
  models: {
    pro: DEEPSEEK_PRO_MODEL,
    flash: DEEPSEEK_FLASH_MODEL,
  },
}

// GLM：Pro 取旗舰 glm-5.3，它同时是新会话的默认模型（`DEFAULT_GLM_MODEL`）——档位表只在会话
// 模型正好是表内 SKU 时才生效，Pro 不取默认模型的话，默认 GLM 会话根本进不了档位路由。
// Flash 取官方同代低价 SKU glm-5.3-flash；两者共享 1M 上下文与强制 Thinking 协议。
const GLM_TIER_ROUTING: SubagentTierRouting = {
  vendor: GLM_VENDOR_ID,
  models: {
    pro: DEFAULT_GLM_MODEL,
    flash: GLM_FLASH_MODEL,
  },
}

// Kimi：能力表里只有 kimi-k3 一个 SKU，所以两档同模型——这不是占位，是照实描述阵容。
// 收益在「会话落进档位表覆盖范围」本身：`runLowCostExtraction` 只对表内会话挂载。
// K3 始终思考，adapter 会忽略抽取路径留下的关闭值，不把 K2.x `thinking` 字段发给上游。
// 代价只有一处、且有界：Flash 失败后的那一次 escalation 会换回同一个模型，退化成一次重试。
const KIMI_TIER_ROUTING: SubagentTierRouting = {
  vendor: KIMI_VENDOR_ID,
  models: {
    pro: DEFAULT_KIMI_MODEL,
    flash: DEFAULT_KIMI_MODEL,
  },
}

/**
 * 逐 vendor 的默认档位表；没有条目 = 这家没有可用的档位阵容。
 *
 * `openai-compat` 故意缺席：它的 baseUrl 由用户填，能力表里 `models` 是空的（没有实测数据
 * 支撑任何一条逐模型覆盖），端点后面挂着什么 SKU 无从得知。缺席的语义由 `defaultTierRouting.ts`
 * 兑现——保守档 + 父会话已配置的模型，与 core `routing.ts` 里「私有网关不假定实现了同样的
 * 档位」的既有裁决一致。将来某个具体服务有了实测数据，先往能力表补 `models`，再来这里加一行。
 *
 * 用 Map 而不是对象字面量：key 是不透明 vendor id，对象查表会撞上 `Object.prototype` 的键
 * （vendor 恰好是 'constructor' 时拿到的不是 undefined），Map 没有这个面。
 */
export const DEFAULT_TIER_ROUTING_TABLES: ReadonlyMap<ModelSettings['vendor'], SubagentTierRouting>
  = new Map([
    [DEEPSEEK_VENDOR_ID, DEEPSEEK_TIER_ROUTING],
    [GLM_VENDOR_ID, GLM_TIER_ROUTING],
    [KIMI_VENDOR_ID, KIMI_TIER_ROUTING],
  ])
