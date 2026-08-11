import { isTauri } from '@tauri-apps/api/core'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { configureCommands } from '@web-agent/core/runtime/commands'
import {
  createMcpClientManager,
  createMcpConnectorRouter,
  createMcpConnectTargetProbe,
  createStreamableHttpMcpConnector,
  registerMcpTools,
} from '@web-agent/tools-mcp'
import { configureMcpSettings, isMcpSettingsConfigured } from './commands'
import { createTauriStdioMcpConnector } from './tauriStdioConnector'

/** Installs the application MCP manager when the settings UI first needs it. */
export function initializeMcpSettings(): void {
  if (isMcpSettingsConfigured()) return

  const tauriHost = isTauri()
  const connector = createMcpConnectorRouter({
    'streamable-http': createStreamableHttpMcpConnector(),
    ...(tauriHost ? { stdio: createTauriStdioMcpConnector() } : {}),
  })
  const manager = createMcpClientManager({ registry: toolRegistry, connector })
  // mcp 域工具需要注入这个进程级 manager —— 装配点就是唯一能同时拿到 registry 与 manager 的地方。
  registerMcpTools(toolRegistry, { manager })
  // 同一个理由的第二根线：连接工具的风险要按目标服务分级（stdio 会在本机起子进程 → 需确认；
  // HTTP 只发网络请求 → 放行），而 core 不能反向依赖本包去查 transport。这里把 mcp 域的探针接进
  // 运行时配置；不接这根线时 core 会把每次连接都当危险处理（从严），不会静默放行。
  configureCommands({ mcpConnectTarget: createMcpConnectTargetProbe(manager) })
  configureMcpSettings({ manager, capabilities: { stdio: tauriHost } })
}
