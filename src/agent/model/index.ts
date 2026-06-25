export { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL, getModelConfig } from './config'
export { DeepSeekModelAdapter } from './deepseek-adapter'
export { MockModelAdapter } from './mock-adapter'
export type {
  AgentTurnContinuation,
  AgentTurnToolPayload,
  AgentTurnToolRequest,
  ConversationContext,
  GenerateFinalAnswerInput,
  AgentTurnInput,
  AgentTurnResult,
  AgentTurnToolResult,
  ModelAdapter,
  ModelAnswer,
  ModelConfig,
  ModelProvider,
  ModelStreamEvent,
  SummarizeInput,
  SummarizeResult,
} from './types'

import { getModelConfig } from './config'
import { DeepSeekModelAdapter } from './deepseek-adapter'
import { MockModelAdapter } from './mock-adapter'
import type { ModelAdapter, ModelConfig } from './types'

export function createModelAdapter(config: ModelConfig = getModelConfig()): ModelAdapter {
  if (config.provider === 'deepseek') {
    return new DeepSeekModelAdapter(config)
  }

  return new MockModelAdapter()
}
