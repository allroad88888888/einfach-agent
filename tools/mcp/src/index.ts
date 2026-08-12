// tools-mcp —— @web-agent/tools-mcp：MCP 运行时（连接管理 + 远端工具适配）与 mcp 域内置工具的
// 桶文件 + 注册器。依赖：仅 @web-agent/core 的工具抽象；core 不反向依赖本包 —— 单向无环。
//
// 与其它五个工具域的差别：本域的工具需要一个【活的运行时依赖】（进程级 McpClientManager），
// 所以注册器是 register<Domain>Tools(registry, dependencies) —— registry 仍是第一个位置参数，
// 注入项收在一个具名对象里（后续要加依赖时不破坏调用点）。宿主在装配期把依赖交进来，
// 工具自身不 import 任何单例；这是本仓「工具需要运行时依赖」的范式写法。
import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import {
  createMcpConnectTool,
  type McpConnectManager,
  type McpLastKnownToolsProbe,
} from './connect-mcp-server/connect-mcp-server'

export * from './types'
export * from './failureClassification'
export * from './connectorRouter'
export * from './streamableHttp'
export * from './toolAdapter'
export * from './placeholderClaims'
export * from './placeholderResult'
export * from './placeholderExecute'
export * from './placeholderTool'
export * from './placeholderSync'
export * from './clientManager'
export * from './connect-mcp-server/connect-mcp-server'
export * from './connect-mcp-server/connectTargetProbe'

/** mcp 域工具所需的运行时依赖。 */
export interface McpToolsDependencies {
  /** 进程级 MCP 连接管理器，由宿主在应用启动时装配。 */
  manager: McpConnectManager
  /**
   * 未连接服务【上次已知】工具清单的只读读出口（F4），由宿主从工具名缓存接进来。
   *
   * 可选：不接这根线时连接工具照常工作，只是描述里不会出现任何清单——模型于是很难知道
   * 「我要的能力在哪个未连接服务上」。所以它虽是可选参数，却是按需连接模式的关键一环。
   */
  lastKnownTools?: McpLastKnownToolsProbe
}

/**
 * 把 mcp 域全部工具注册进给定 registry（幂等：同名覆盖）。
 *
 * 依赖缺失时【在装配期就抛】，不注册一个到调用时才崩的半成品工具 —— 宿主接错线要在启动时暴露，
 * 而不是等某轮对话里模型调到它才发现。
 */
export function registerMcpTools(
  registry: ToolRegistry,
  dependencies: McpToolsDependencies,
): void {
  if (!dependencies?.manager) {
    throw new Error('registerMcpTools requires an MCP client manager')
  }
  const options = { lastKnownTools: dependencies.lastKnownTools }
  for (const tool of [createMcpConnectTool(dependencies.manager, options)]) {
    registry.register(tool)
  }
}
