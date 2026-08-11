import type { UserInputPreparer } from '../userInputPreparation'
import type { UserContentDisposer } from '../userContentDisposal'
import type { McpConnectTargetProbe } from '../dangerousTools'

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
  /**
   * serverId → 该 MCP 服务的落地方式，由装配 MCP manager 的宿主接上。
   * 风险分级靠它区分「stdio 会在本机起子进程」和「HTTP 只发网络请求」；
   * 不接线时 classifyToolRisk 一律按需确认（从严），不会静默放行。
   */
  mcpConnectTarget?: McpConnectTargetProbe
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
