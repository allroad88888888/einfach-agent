// M9 · 设置袋形状兼容层的单测。
// ---------------------------------------------------------------------------
// 覆盖四条不变量：老形状（顶层平铺特化字段）搬进设置袋、新形状原样返回同一引用、
// 新旧同名字段以袋内为准、空袋子不留下痕迹。

import { describe, expect, it } from 'vitest'

import type { ModelSettings } from '../core.type'
import { liftLegacyVendorSettings, withVendorSettings } from './settingsBagMigration'

describe('liftLegacyVendorSettings', () => {
  it('把顶层的历史特化字段搬进设置袋，通用字段留在顶层', () => {
    const legacy = {
      vendor: 'kimi',
      model: 'kimi-k2.6',
      thinking: true,
      temperature: 0.3,
      max_tokens: 128,
      region: 'global',
      reasoning_effort: 'high',
    } as unknown as ModelSettings

    expect(liftLegacyVendorSettings(legacy)).toEqual({
      vendor: 'kimi',
      model: 'kimi-k2.6',
      thinking: true,
      temperature: 0.3,
      max_tokens: 128,
      vendorSettings: { region: 'global', reasoning_effort: 'high' },
    })
  })

  it('已是新形状时原样返回同一引用（调用方靠 !== 判断这轮有没有改）', () => {
    const current: ModelSettings = {
      vendor: 'some-new-provider',
      model: 'x',
      vendorSettings: { region: 'cn' },
    }

    expect(liftLegacyVendorSettings(current)).toBe(current)
  })

  it('幂等：搬运结果再搬一次不变', () => {
    const legacy = { vendor: 'kimi', model: 'kimi-k2.6', region: 'cn' } as unknown as ModelSettings
    const once = liftLegacyVendorSettings(legacy)

    expect(liftLegacyVendorSettings(once)).toBe(once)
  })

  it('同名字段以设置袋里的新值为准，顶层残留的老值丢弃', () => {
    const mixed = {
      vendor: 'kimi',
      model: 'kimi-k2.6',
      region: 'global',
      vendorSettings: { region: 'cn' },
    } as unknown as ModelSettings

    expect(liftLegacyVendorSettings(mixed).vendorSettings).toEqual({ region: 'cn' })
  })

  it('不原地改入参', () => {
    const legacy = { vendor: 'kimi', model: 'kimi-k2.6', region: 'cn' } as unknown as ModelSettings

    liftLegacyVendorSettings(legacy)

    expect(legacy).toHaveProperty('region', 'cn')
  })
})

describe('withVendorSettings', () => {
  it('袋子空了就整个删掉字段', () => {
    const settings: ModelSettings = {
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      vendorSettings: { reasoning_effort: 'max' },
    }

    expect(withVendorSettings(settings, {})).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
    })
  })

  it('袋子非空时替换整袋', () => {
    const settings: ModelSettings = { vendor: 'glm', model: 'glm-5' }

    expect(withVendorSettings(settings, { reasoning_effort: 'low' }).vendorSettings)
      .toEqual({ reasoning_effort: 'low' })
  })
})
