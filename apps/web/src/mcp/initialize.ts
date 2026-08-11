import { isTauri } from '@tauri-apps/api/core'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { rootStore } from '@web-agent/core/state/rootStore'
import { configureCommands } from '@web-agent/core/runtime/commands'
import {
  createMcpClientManager,
  createMcpConnectorRouter,
  createMcpConnectTargetProbe,
  createStreamableHttpMcpConnector,
} from '@web-agent/tools-mcp'
import {
  configureMcpSettings,
  isMcpServerConnected,
  isMcpSettingsConfigured,
  readMcpToolNameCache,
} from './commands'
import { mcpServerConfigsAtom } from './state'
import { mayLaunchMcpServer, stdioCommandLine } from './stdioLaunchConsent'
import { createTauriStdioMcpConnector } from './tauriStdioConnector'
import { wireMcpToolProbes } from './toolProbeWiring'

/**
 * 模型发起的连接要不要先问一次（F8）：这条命令行用户确认过吗。
 *
 * 【为什么这个判断只能在这里做】起进程确认记在持久化配置的 launchConsent 指纹上，那是
 *   app 层的东西；而探针在 tools/mcp 层只看得到 manager 登记表里的连接字段。装配点是唯一
 *   同时拿得到两样东西的地方，所以事实在这里注入，判定仍然只有 mayLaunchMcpServer 一处。
 *
 * 【为什么还要比一次命令行】用户批准的是「在我的机器上执行这一条」。真正会被执行的是
 *   manager 登记表里那一条（连接工具走 manager.reconnect）。两者对不上就说明确认覆盖的
 *   不是这次要跑的命令 —— 当作没确认过。
 *
 * 任何一步答不上来都返回 false：宁可多问一次，不能静默起一次进程。
 */
function isMcpLaunchConsented(serverId: string, commandLine: string): boolean {
  const config = rootStore.getter(mcpServerConfigsAtom).find((entry) => entry.id === serverId)
  if (!config || config.transport !== 'stdio') return false
  if (stdioCommandLine(config) !== commandLine) return false
  return mayLaunchMcpServer(config)
}

/** Installs the application MCP manager when the settings UI first needs it. */
export function initializeMcpSettings(): void {
  if (isMcpSettingsConfigured()) return

  const tauriHost = isTauri()
  const connector = createMcpConnectorRouter({
    'streamable-http': createStreamableHttpMcpConnector(),
    ...(tauriHost ? { stdio: createTauriStdioMcpConnector() } : {}),
  })
  const manager = createMcpClientManager({ registry: toolRegistry, connector })
  // 同一个理由的第二根线：连接工具的风险要按目标服务分级（stdio 会在本机起子进程 → 需确认；
  // HTTP 只发网络请求 → 放行），而 core 不能反向依赖本包去查 transport。这里把 mcp 域的探针接进
  // 运行时配置；不接这根线时 core 会把每次连接都当危险处理（从严），不会静默放行。
  // 探针另外带上「这条启动命令确认过没有」（F8）：没确认过的 stdio 连接在 Auto 模式下也要暂停。
  configureCommands({
    mcpConnectTarget: createMcpConnectTargetProbe(manager, {
      isLaunchConsented: isMcpLaunchConsented,
    }),
  })
  configureMcpSettings({ manager, capabilities: { stdio: tauriHost } })
  // mcp 域工具需要注入这个进程级 manager —— 装配点就是唯一能同时拿到 registry 与 manager 的地方。
  // 顺带把工具名缓存喂给模型看得见的那两处（B5，规矩见 toolProbeWiring.ts）：两个读出口都从
  // commands.ts 走，因此 configureMcpSettings 之后换掉的 service 也能被这两根线读到。
  // 缓存本身在 hydrateMcpSettings() 里从磁盘读进来（main.tsx 启动时就调）。
  wireMcpToolProbes({
    registry: toolRegistry,
    manager,
    getCache: readMcpToolNameCache,
    isConnected: isMcpServerConnected,
    configure: configureCommands,
  })
}
