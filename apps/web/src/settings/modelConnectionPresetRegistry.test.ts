import { describe, expect, it } from 'vitest'
import { normalizeOpenAiCompatBaseUrl } from '../../../../packages/host-node/src/model/openAiCompatBaseUrl'
import {
  modelConnectionPreset,
  modelConnectionPresets,
} from './modelConnectionPresetRegistry'

describe('model connection preset registry', () => {
  it('provides only OpenAI-compatible cloud, self-hosted, and local sources', () => {
    const presets = modelConnectionPresets()

    expect(presets.map((preset) => preset.id)).toEqual([
      'lm-studio',
      'ollama',
      'openrouter',
      'sglang',
      'siliconflow',
      'vllm',
      'volcengine-ark',
    ])
    expect(presets.map((preset) => preset.category)).toEqual([
      'local', 'local', 'cloud', 'self-hosted', 'cloud', 'self-hosted', 'cloud',
    ])
    expect(presets.every((preset) => preset.protocol === 'openai-compatible')).toBe(true)
    expect(presets.map((preset) => preset.id)).not.toContain('deepseek')
    expect(presets.map((preset) => preset.id)).not.toContain('glm')
    expect(presets.map((preset) => preset.id)).not.toContain('kimi')
  })

  it('uses valid endpoints while leaving self-hosted endpoints for the user to enter', () => {
    for (const preset of modelConnectionPresets()) {
      if (preset.category === 'self-hosted') {
        expect(preset.baseUrl).toBe('')
      } else {
        expect(normalizeOpenAiCompatBaseUrl(preset.baseUrl)).toBe(preset.baseUrl)
      }
      expect(preset.models.every((model) => model.source === 'manual')).toBe(true)
    }
  })

  it('returns stable defensive copies for collection and lookup consumers', () => {
    const first = modelConnectionPresets()
    const second = modelConnectionPresets()
    expect(second).toEqual(first)
    expect(second).not.toBe(first)

    const preset = modelConnectionPreset('ollama')
    expect(preset).toEqual(first[1])
    expect(modelConnectionPreset('missing')).toBeUndefined()

    const mutated = first as unknown as Array<{ label: string; models: Array<{ label: string }> }>
    mutated[1].label = 'changed'
    mutated[1].models[0].label = 'changed'
    expect(modelConnectionPreset('ollama')).toEqual(preset)
  })
})
