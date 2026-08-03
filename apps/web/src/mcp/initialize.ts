import { isTauri } from '@tauri-apps/api/core'
import { toolRegistry } from '@web-agent/core/tools/registry'
import {
  createMcpClientManager,
  createMcpConnectorRouter,
  createStreamableHttpMcpConnector,
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
  configureMcpSettings({ manager, capabilities: { stdio: tauriHost } })
}
