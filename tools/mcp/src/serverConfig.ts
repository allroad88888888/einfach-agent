import type { ToolRuntime } from '@web-agent/core/tools/types'
import type { McpServerConfig } from './types'

/**
 * McpServerConfig 的**取用规则**：怎么复制成自己的、怎么判它合法、它该跑在哪个 runtime。
 *
 * 从 clientManager.ts 拆出来是因为这三件事都只看配置本身，不需要连接、注册表或状态机；
 * 混在生命周期文件里会让「纯校验」和「有副作用的编排」共用一个阅读上下文。
 */

/**
 * 深拷贝调用方传进来的配置。管理器会长期持有 config 并在重连时复用，
 * 直接存引用等于让调用方事后改配置能改到一个已经连上的连接。
 */
export function cloneConfig(config: McpServerConfig): McpServerConfig {
  if (config.transport === 'streamable-http') {
    return {
      ...config,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    }
  }
  return {
    ...config,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
  }
}

/**
 * 连接前的硬校验。这里抛出的 message 是本包自己写的确定字符串，
 * failureClassification.ts 的 PERMANENT_MESSAGE_RULES 依赖它们判永久失败 ——
 * 改这些文案要同步改那张表。
 */
export function validateConfig(config: McpServerConfig): void {
  if (!config.id || !config.id.trim()) {
    throw new Error('MCP server id must not be empty')
  }

  if (config.transport === 'streamable-http') {
    const url = new URL(config.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`MCP Streamable HTTP URL must use http or https: ${config.url}`)
    }
    return
  }

  if (config.transport === 'stdio') {
    if (!config.command || !config.command.trim()) {
      throw new Error('MCP stdio command must not be empty')
    }
    return
  }

  const exhaustive: never = config
  throw new Error(`Unsupported MCP transport: ${String(exhaustive)}`)
}

/** stdio 服务跑在宿主进程里，只有桌面端能执行；HTTP 服务浏览器内即可调用。 */
export function runtimeFor(config: McpServerConfig): ToolRuntime {
  return config.transport === 'stdio' ? 'server' : 'internal'
}
