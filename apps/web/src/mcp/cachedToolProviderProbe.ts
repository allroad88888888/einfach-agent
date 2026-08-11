// apps/web/src/mcp/cachedToolProviderProbe.ts —— 把工具名缓存翻译成 core 遇到一个完全不认识的
// 工具名时唯一需要的那条事实：这个名字上次已知出自哪个【尚未连接】的已配置服务。
//
// 【为什么翻译在 app 层】缓存落在磁盘（~/.webAgent/config.json 或 localStorage），而 core 不碰
//   磁盘、也不能反向依赖 tools-* 或 app。切法与 F3 的连接目标探针完全一致：core 定策略、宿主给
//   事实、装配期接线（见 tools/mcp/src/connect-mcp-server/connectTargetProbe.ts 的同款说明）。
//   core 因此不需要认识 `mcp__` 前缀，判据只是「这个名字我不认识」。
//
// 【为什么必须传 isConnected】清单是「上次已知」，不是当前事实。服务已经连上时本探针必须闭嘴：
//   连上之后一律以服务返回的真实清单为准，此时仍找不到的工具就是真的没有了（改名、下线），
//   再回一句「请先连接」会把模型推进「连接 → 还是没有 → 再连接」的死循环。这个参数没有默认值，
//   就是不想让接线方"先不管连接状态"——那正是最容易误导模型的一种接法。
import type {
  UnconnectedToolProvider,
  UnconnectedToolProviderProbe,
} from '@web-agent/core/tools/schemaResult'
import { findLastKnownToolProvider, type McpToolNameCache } from './toolNameCache'

export interface CachedToolProviderProbeSource {
  /** 取当前这份缓存。缓存是不可变值，每次写入换一份新的，所以每次都重新取。 */
  getCache(): McpToolNameCache
  /** serverId → 该服务此刻是否已连接。已连接的服务不回答，理由见文件头。 */
  isConnected(serverId: string): boolean
  /** (serverId, 远端工具名) → 注册进 ToolRegistry 的工具名；传 tools-mcp 的 makeMcpToolName。 */
  toRegisteredName(serverId: string, remoteToolName: string): string
}

/**
 * 造一个绑定到给定缓存与连接状态的「未连接提供方」探针。
 *
 * 装配点（B5 把缓存读进服务视图后）用它接进 RuntimeConfig.unconnectedToolProvider：
 *   configureCommands({ unconnectedToolProvider: createCachedToolProviderProbe({ ... }) })
 * 不接这根线时 core 保持未知工具的原有回执，不会凭空断言存在某个未连接的服务。
 */
export function createCachedToolProviderProbe(
  source: CachedToolProviderProbeSource,
): UnconnectedToolProviderProbe {
  if (typeof source?.getCache !== 'function'
    || typeof source?.isConnected !== 'function'
    || typeof source?.toRegisteredName !== 'function') {
    throw new Error('createCachedToolProviderProbe requires getCache, isConnected and toRegisteredName')
  }
  return (toolName): UnconnectedToolProvider | undefined => {
    const found = findLastKnownToolProvider(source.getCache(), toolName, source.toRegisteredName)
    if (!found || source.isConnected(found.serverId)) return undefined
    return { serverId: found.serverId, cachedAt: found.cachedAt }
  }
}
