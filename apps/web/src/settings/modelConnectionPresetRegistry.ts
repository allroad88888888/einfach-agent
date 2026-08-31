import type { ConnectionProfileModel } from './modelConnectionProfileHost'

export type ModelConnectionPresetCategory = 'cloud' | 'self-hosted' | 'local'

export interface ModelConnectionPreset {
  readonly id: string
  readonly label: string
  readonly category: ModelConnectionPresetCategory
  readonly protocol: 'openai-compatible'
  readonly baseUrl: string
  readonly models: readonly ConnectionProfileModel[]
  readonly documentationUrl?: string
}

type PresetDefinition = Omit<ModelConnectionPreset, 'models'> & {
  readonly models: readonly string[]
}

const PRESET_DEFINITIONS: readonly PresetDefinition[] = [
  {
    id: 'lm-studio',
    label: 'LM Studio',
    category: 'local',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    documentationUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
  },
  {
    id: 'ollama',
    label: 'Ollama OpenAI compatibility',
    category: 'local',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['llama3.2', 'qwen2.5'],
    documentationUrl: 'https://docs.ollama.com/openai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'cloud',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct'],
    documentationUrl: 'https://openrouter.ai/docs/api-reference/overview',
  },
  {
    id: 'sglang',
    label: 'SGLang',
    category: 'self-hosted',
    protocol: 'openai-compatible',
    baseUrl: '',
    models: ['model-id'],
    documentationUrl: 'https://docs.sglang.ai/backend/openai_api.html',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    category: 'cloud',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'],
    documentationUrl: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    category: 'self-hosted',
    protocol: 'openai-compatible',
    baseUrl: '',
    models: ['model-id'],
    documentationUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
  },
  {
    id: 'volcengine-ark',
    label: '火山方舟',
    category: 'cloud',
    protocol: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['deepseek-r1-250120', 'doubao-1-5-pro-32k-250115'],
    documentationUrl: 'https://www.volcengine.com/docs/82379/1399008',
  },
]

function copyPreset(definition: PresetDefinition): ModelConnectionPreset {
  return {
    ...definition,
    models: definition.models.map((id) => ({ id, label: id, source: 'manual' })),
  }
}

/** Returns presets in stable application-key order; callers receive independent copies. */
export function modelConnectionPresets(): readonly ModelConnectionPreset[] {
  return PRESET_DEFINITIONS.map(copyPreset)
}

/** Looks up a stable application preset key without exposing the stored definition. */
export function modelConnectionPreset(id: string): ModelConnectionPreset | undefined {
  const definition = PRESET_DEFINITIONS.find((preset) => preset.id === id)
  return definition === undefined ? undefined : copyPreset(definition)
}
