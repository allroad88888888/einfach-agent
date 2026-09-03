// 会话设置的**形状**兼容层：把老数据里平铺在顶层的供应商特化字段收进 vendorSettings 设置袋。
// ---------------------------------------------------------------------------
// 背景：`SessionMeta.settings` 是持久化字段。设置袋启用之前，各家的特化字段（推理档位、
//   区域等）直接平铺在 settings 顶层——存量会话读回来仍然是那个形状。若不搬运，这些字段
//   会在发请求时被静默丢掉（用户选过的区域/档位无声失效），比报错更难发现。
// 判据是**结构**而不是厂商：顶层只认 modelSettingsSchema 的跨厂商通用字段，其余一律视为
//   特化字段搬进袋子。因此这层不需要认识任何厂商，也不需要随新 provider 增补名单。

import { MODEL_SETTINGS_FIELDS, type ModelSettings } from '../modelSettingsSchema'

// 简介：把设置袋写回一份设置；袋子空了就整个删掉这个字段。
// 详情：空袋子既没有信息又会让「读回的对象和新建的对象长得不一样」，故不保留。
export function withVendorSettings(
  settings: ModelSettings,
  vendorSettings: Record<string, unknown>,
): ModelSettings {
  if (Object.keys(vendorSettings).length > 0) return { ...settings, vendorSettings }
  const { vendorSettings: _dropped, ...rest } = settings
  return rest
}

/**
 * 把顶层的历史特化字段搬进设置袋；无需搬运时**原样返回同一引用**。
 *
 * 冲突时以已经在袋子里的值为准：那是新形状写入的，比顶层残留的历史值新。
 */
export function liftLegacyVendorSettings(settings: ModelSettings): ModelSettings {
  const record: Record<string, unknown> = settings
  const legacyKeys = Object.keys(record).filter((key) => !MODEL_SETTINGS_FIELDS.has(key))
  if (legacyKeys.length === 0) return settings

  const vendorSettings: Record<string, unknown> = { ...settings.vendorSettings }
  const migrated: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (MODEL_SETTINGS_FIELDS.has(key)) migrated[key] = value
    else if (!(key in vendorSettings)) vendorSettings[key] = value
  }
  return withVendorSettings(migrated as ModelSettings, vendorSettings)
}
