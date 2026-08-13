import type { KimiRegion } from '@web-agent/ai'
import type { ModelSettings } from '@web-agent/core/state/core.type'

/**
 * 从会话设置袋里取出 Kimi 的区域。
 *
 * 区域是 Kimi 独有的特化字段，core 只把它原样搬在 `vendorSettings` 里、不解释；
 * 宿主这一侧才认识它，所以「袋里的 unknown → KimiRegion」这一步收在这一个函数里。
 * 刻意**不做纠错**：持久化里的非法值原样返回，交给各调用方按自己的策略拒绝，
 * 而不是在这里悄悄兜底成默认区域。
 */
export function kimiRegionSetting(settings?: Readonly<ModelSettings>): KimiRegion | undefined {
  return settings?.vendorSettings?.region as KimiRegion | undefined
}
