import { describe, expect, it } from 'vitest'
import {
  MODEL_SETTINGS_FIELDS,
  MODEL_SETTINGS_FIELD_SCHEMA,
  isModelSettings,
  type ModelSettings,
} from './modelSettingsSchema'

describe('ModelSettings field schema', () => {
  it('字段集合由 schema 唯一导出，静态类型也接受完整设置', () => {
    const settings: ModelSettings = {
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: true,
      temperature: 0.3,
      max_tokens: 4_000,
      vendorSettings: { reasoning_effort: 'high' },
    }

    expect([...MODEL_SETTINGS_FIELDS]).toEqual(Object.keys(MODEL_SETTINGS_FIELD_SCHEMA))
    expect([...MODEL_SETTINGS_FIELDS]).toEqual([
      'vendor', 'model', 'thinking', 'temperature', 'max_tokens', 'vendorSettings',
    ])
    expect(isModelSettings(settings)).toBe(true)
  })

  it.each([
    {},
    { vendor: 'deepseek' },
    { vendor: 1, model: 'x' },
    { vendor: 'deepseek', model: 'x', thinking: 'yes' },
    { vendor: 'deepseek', model: 'x', temperature: Number.POSITIVE_INFINITY },
    { vendor: 'deepseek', model: 'x', max_tokens: -0 },
    { vendor: 'deepseek', model: 'x', vendorSettings: [] },
    { vendor: 'deepseek', model: 'x', futureField: true },
  ])('拒绝缺字段、未知字段或类型不符的设置：%j', (value) => {
    expect(isModelSettings(value)).toBe(false)
  })
})
