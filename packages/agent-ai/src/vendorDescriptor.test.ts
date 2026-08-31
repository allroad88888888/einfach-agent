import { describe, expect, it } from 'vitest'
import {
  contextWindowTokens,
  maxTurnToolsForVendor,
  vendorDescriptorFor,
} from './vendorDescriptor'

describe('vendor descriptor', () => {
  it('uses exact model windows before its conservative vendor fallback', () => {
    expect(contextWindowTokens('deepseek', 'deepseek-v4-pro')).toBe(1_000_000)
    expect(contextWindowTokens('glm', 'glm-5.3-flash')).toBe(1_000_000)
    expect(contextWindowTokens('deepseek', 'private-model')).toBe(64_000)
  })

  it('uses the fallback descriptor for unknown vendors and exposes turn tool capacity', () => {
    expect(contextWindowTokens('unknown', 'unknown')).toBe(64_000)
    expect(maxTurnToolsForVendor('deepseek')).toBe(vendorDescriptorFor('deepseek').maxTurnTools)
    expect(maxTurnToolsForVendor('glm')).toBe(vendorDescriptorFor('glm').maxTurnTools)
  })
})
