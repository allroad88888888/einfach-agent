// apps/web/src/mcp/toolProbeWiring.ts —— 把工具名缓存接到【模型看得见】的那两处（B5）。
//
// 按需连接模式要成立，模型必须能回答两个问题，而两个答案都只在这份缓存里：
//   1.「我要的能力在哪个还没连的服务上？」→ F4：未连接服务的清单进 connect_mcp_server 的描述。
//   2.「我直接点名调了一个缓存里的工具，为什么不认识？」→ B4：把 unknown tool 换成「请先连接」。
// 两根线各自的实现早就写好了（cachedToolProviderProbe.ts / tools-mcp 的 lastKnownTools.ts），
// 但不接上就都是死代码——它们没有任何自发的调用者。
//
// 【为什么两根线放在一个函数里】它们喂的是同一份缓存，且必须同进同退：只接 F4 而不接 B4，
// 模型就会看着清单点名调用、然后收到一句 unknown tool；只接 B4 而不接 F4，模型压根不知道
// 有哪些未连接服务值得连。分开接线 = 给「只接了一半」留后门。
//
// 【为什么单独成文件】这是纯装配：把宿主手里的四样东西（registry / manager / 缓存读出口 /
// 连接状态）按上面的规矩组起来。抽出来才有一个可以直接断言「线真的接上了」的单元——
// initialize.ts 那边还夹着 isTauri、连接器路由等一堆与本判据无关的东西。

import type { UnconnectedToolProviderProbe } from '@web-agent/core/tools/schemaResult'
import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { registerMcpTools, type McpConnectManager } from '@web-agent/tools-mcp'
import { createCachedToolProviderProbe } from './cachedToolProviderProbe'
import { listLastKnownTools, type McpToolNameCache } from './toolNameCache'

export interface McpToolProbeWiringOptions {
  registry: ToolRegistry
  manager: McpConnectManager
  /**
   * 取当前那份工具名缓存。必须是进程内那一份的读出口（commands.ts 的 readMcpToolNameCache），
   * 不能是调用方自己攒的快照——那样两根线看到的会是各自不同的旧数据。
   */
  getCache(): McpToolNameCache
  /**
   * serverId → 此刻是否已连接。B4 立的硬约束：已连接的服务探针必须闭嘴，否则「缓存里有、
   * 连上后已下线」的工具会被答成「请先连接」，把模型推进连接死循环。
   */
  isConnected(serverId: string): boolean
  /** 把探针接进运行时配置；宿主传 core 的 configureCommands。 */
  configure(config: { unconnectedToolProvider: UnconnectedToolProviderProbe }): void
}

/** 注册 mcp 域工具（带上次已知清单），并把未连接工具探针接进运行时配置。 */
export function wireMcpToolProbes({
  registry,
  manager,
  getCache,
  isConnected,
  configure,
}: McpToolProbeWiringOptions): void {
  // F4：清单在【调用当刻】才从缓存取，所以探测/连接刷新写进缓存之后立刻生效，
  // 不需要重新 registerMcpTools。
  registerMcpTools(registry, {
    manager,
    lastKnownTools: () => listLastKnownTools(getCache()),
  })
  // B4：缓存条目名就是注册名（写入侧已经过一次 makeMcpToolName），模型点名用的也是它，
  // 所以这里只需把缓存和连接状态递进去，不再注入任何名字映射——再拼一次就是双重前缀。
  configure({
    unconnectedToolProvider: createCachedToolProviderProbe({ getCache, isConnected }),
  })
}
