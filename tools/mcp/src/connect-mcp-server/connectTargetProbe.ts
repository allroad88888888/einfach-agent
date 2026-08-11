// tools/mcp/src/connect-mcp-server/connectTargetProbe.ts —— 把 manager 的服务登记表翻译成
// core 做风险分级时唯一需要的那条事实：连接这个服务会不会在用户本机拉起子进程。
//
// 【为什么翻译在这里而不是 core】依赖方向是 agent-core ← tools-*，core 不能反向 import 本包去查
//   transport。于是职责这样切：core 只声明探针类型、定策略（本机起进程 → 要确认；纯网络 → 放行；
//   答不上来 → 从严），本域提供事实，宿主在装配期把两者接起来（apps/web/src/mcp/initialize.ts）。
//
// 【为什么不直接把 manager 交给 core】manager 上有 connect(config) 这类能力面，把整只 manager
//   递进 core 等于顺手把它暴露给风险判定之外的一切。探针只回答一个问题，且不回传任何连接配置
//   （url / headers / env 可能含凭据），只回传本机会执行的命令行。
import type { McpConnectTarget, McpConnectTargetProbe } from '@web-agent/core/runtime/dangerousTools'
import type { McpServerConfig } from '../types'
import type { McpConnectManager } from './connect-mcp-server'

/** 探针只用得到查表这一项能力。 */
export type McpConnectTargetSource = Pick<McpConnectManager, 'get'>

/** stdio 服务将要执行的命令行（给用户看，不给 shell 跑，所以不做转义）。 */
function stdioCommandLine(command: string, args: readonly string[] | undefined): string {
  return [command, ...(args ?? [])].filter((part) => part.length > 0).join(' ')
}

function describeTarget(config: McpServerConfig): McpConnectTarget | undefined {
  if (config.transport === 'stdio') {
    return { spawnsLocalProcess: true, command: stdioCommandLine(config.command, config.args) }
  }
  if (config.transport === 'streamable-http') {
    return { spawnsLocalProcess: false }
  }
  // 将来新增的传输方式在这里没被判定过 —— 返回 undefined 让 core 走「答不上来」的从严分支，
  // 而不是默认当成远程放行。忘了在这里补一条，最坏结果是多问用户一次。
  return undefined
}

/**
 * 造一个绑定到给定 manager 的落地探针。
 * 未登记的 serverId 返回 undefined：连接工具本来就只认登记表，core 那边也按从严处理。
 */
export function createMcpConnectTargetProbe(
  manager: McpConnectTargetSource,
): McpConnectTargetProbe {
  if (!manager || typeof manager.get !== 'function') {
    throw new Error('createMcpConnectTargetProbe requires an MCP client manager')
  }
  return (serverId) => {
    const server = manager.get(serverId)
    return server ? describeTarget(server.config) : undefined
  }
}
