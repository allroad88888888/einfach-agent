import type { ModelSettings } from '../../state/core.type'
import type { UserInputPreparer } from '../userInputPreparation'
import type { UserContentDisposer } from '../userContentDisposal'
import type { McpConnectTargetProbe, McpToolLaunchTargetProbe } from '../dangerousTools'
import type { ModelEscalationPolicy } from '../modelEscalation'
import type { UnconnectedToolProviderProbe } from '../../tools/schemaResult'
import type { ViewImageCapability } from '../../tools/types'

/** Runtime dependencies supplied by the host application. */
export interface RuntimeConfig {
  /**
   * vendor id（对 core 是不透明字符串，取值由装配层与 agent-ai 的 provider registry 商定）
   * → 该厂商的 API Key。core 只按会话的 `settings.vendor` 查表，不认识任何具体厂商名；
   * 新增一家 provider 不需要改这里。
   *
   * 注意语义：`configureCommands` 走 `Object.assign`，传入的 map 会整体替换旧 map，
   * 不做逐 vendor 合并——装配层每次都传完整的凭据表。
   */
  modelCredentials: Record<string, string>
  /**
   * 新会话在调用方没有显式给设置时用的缺省模型设置。
   * core 不认识任何厂商，也就编不出默认 vendor/model：装配层不接这一项时，退回
   * agent-ai 内置装配给出的缺省（见 `DEFAULT_MODEL_SETTINGS`）。
   */
  defaultModelSettings?: ModelSettings
  /**
   * 装配层给的不透明调用方标识（可不给）。core 只把它原样交给当前会话 provider 的 adapter，
   * 既不解释也不校验，更不知道有没有哪家会把它发上行——「是否上行、上行成哪个字段、非法值
   * 怎么处理」全部由 adapter 决定（见 `packages/agent-ai` 的 provider registry）。
   *
   * 隐私语义由装配层负责：只允许放本机生成的随机 ID，不得放邮箱、账号、路径等真实身份；
   * 协议边界对不合法的值整体丢弃而不是截断，避免把私密数据「修剪」成仍会发出去的标识。
   */
  modelUserId?: string
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
  /**
   * 主 Agent 遇到「值得换模型再来一次」的判据时问谁。判据本身与子 Agent 共用
   * （`@einfach-agent/ai` 的 modelCapacityEscalation），**换不换**才是这一项决定的。
   * 不接线时主 Agent 一律不升档：用户在会话里选的就是这个模型，run 照旧显式失败
   * （理由见 `runtime/modelEscalation.ts` 开头）。
   */
  modelEscalation?: ModelEscalationPolicy
  /** Optional app-owned image inspection port; core only supplies guarded workspace access. */
  viewImage?: ViewImageCapability
}

export function createRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    modelCredentials: {},
    customInstructions: '',
    ...overrides,
  }
}
