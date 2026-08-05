import type { UserInputPreparer } from '../userInputPreparation'
import type { UserContentDisposer } from '../userContentDisposal'

/** Runtime dependencies supplied by the host application. */
export interface RuntimeConfig {
  deepseekApiKey: string
  deepseekUserId?: string
  glmApiKey: string
  kimiApiKey: string
  customInstructions: string
  fetchImpl?: typeof fetch
  prepareUserInput?: UserInputPreparer
  disposeUserContent?: UserContentDisposer
}

export function createRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    deepseekApiKey: '',
    glmApiKey: '',
    kimiApiKey: '',
    customInstructions: '',
    ...overrides,
  }
}
