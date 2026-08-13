// 会话 ModelSettings → 发请求 / 观测所需的投影。
// ---------------------------------------------------------------------------
// core 只搬运 `vendorSettings` 这个供应商附加设置袋，不解释袋内任何 key：谁认识哪个字段，
// 由 agent-ai 的 adapter 决定（见 packages/agent-ai/src/builtinProviders.ts）。

import type { ChatRequestBase, ModelAdapterSettings } from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'

/** Projects the cross-vendor sampling parameters carried at the top level. */
export function modelSamplingSettings(settings: ModelSettings): {
  temperature: ChatRequestBase['temperature'] | undefined
  maxTokens: ChatRequestBase['max_tokens'] | undefined
} {
  // 「哪家不接受采样参数」是厂商事实，由该家 adapter 在投影请求时自己丢弃；
  // core 这里一律原样带上会话里存的值。
  return { temperature: settings.temperature, maxTokens: settings.max_tokens }
}

/**
 * 供观测与缓存指纹使用的推理档位标识。
 *
 * 只读不改：core 不会因为这个值改变请求（请求侧的 reasoning_effort 由 adapter 从设置袋里
 * 取），但缓存分档与 trace 要能看出「同一会话换过档位」，故在这里把袋内值读成字符串。
 * 非字符串（老数据或某家用了别的形状）一律当作没有，不往观测里塞未知结构。
 */
export function modelReasoningEffort(settings: ModelSettings): string | undefined {
  const value = settings.vendorSettings?.reasoning_effort
  return typeof value === 'string' ? value : undefined
}

/**
 * 摊平成 adapter 的设置形状：不透明 vendorId + 该厂商的附加字段。
 *
 * vendor 放在最后写，袋子里即使混进同名 key 也不能改写会话真正挂靠的 provider。
 */
export function modelAdapterSettings(settings: ModelSettings): ModelAdapterSettings {
  return { ...settings.vendorSettings, vendor: settings.vendor }
}
