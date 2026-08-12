import type { UserInputPreparer } from '../userInputPreparation'
import type { UserContentDisposer } from '../userContentDisposal'
import type { McpConnectTargetProbe, McpToolLaunchTargetProbe } from '../dangerousTools'
import type { UnconnectedToolProviderProbe } from '../../tools/schemaResult'

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
  /**
   * 注册名 → 这次 `mcp__*` 调用会不会先在本机起进程，由装配占位工具的宿主接上（D3a）。
   * 未连接服务的占位被直接调用时会先透明连接，stdio 的那一次连接就是一次起进程；
   * 不接线时 classifyToolRisk 维持 `mcp__*` 的既有 dangerous（不从严，理由见探针类型注释）。
   */
  mcpToolLaunchTarget?: McpToolLaunchTargetProbe
  /**
   * 工具名 → 提供它的、当前【未连接】的 MCP 服务，由持有工具名缓存的宿主接上。
   * core 只在一个工具名彻底不认识时问它一次，据此把「unknown tool」换成「请先连接」。
   * 不接线时保持未知工具的原有回执，绝不凭空断言存在某个未连接的服务。
   */
  unconnectedToolProvider?: UnconnectedToolProviderProbe
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
