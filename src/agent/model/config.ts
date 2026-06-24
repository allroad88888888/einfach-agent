import type { ModelConfig, ModelProvider } from './types'

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

type ModelEnv = Partial<Record<string, string | undefined>>

export function getModelConfig(env: ModelEnv = import.meta.env): ModelConfig {
  const apiKey = env.VITE_DEEPSEEK_API_KEY?.trim() ?? ''
  const provider = normalizeProvider(env.VITE_AGENT_MODEL_PROVIDER, apiKey)

  return {
    provider,
    apiKey,
    model: env.VITE_DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    baseUrl: normalizeBaseUrl(env.VITE_DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL),
  }
}

function normalizeProvider(value: string | undefined, apiKey: string): ModelProvider {
  if (value === 'mock' || value === 'deepseek') return value
  return apiKey ? 'deepseek' : 'mock'
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, '')
}
