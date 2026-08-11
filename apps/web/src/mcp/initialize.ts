import { isTauri } from '@tauri-apps/api/core'
import { toolRegistry } from '@web-agent/core/tools/registry'
import {
  createMcpClientManager,
  createMcpConnectorRouter,
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
  configureMcpSettings({ manager, capabilities: { stdio: tauriHost } })
}
