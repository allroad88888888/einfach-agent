import type { McpServerStatus } from '@web-agent/tools-mcp'

export type SettingsCenterTab = 'mcp' | 'model' | 'instructions' | 'general' | 'skills'
export type McpTransport = 'streamable-http' | 'stdio'
export type McpPersistenceMode = 'persistent' | 'temporary'
export type McpAddMode = 'form' | 'json'

export interface McpSettingsCapabilities {
  stdio: boolean
}

interface PersistedMcpServerBase {
  id: string
  name: string
  autoConnect: boolean
}

export interface PersistedHttpMcpServer extends PersistedMcpServerBase {
  transport: 'streamable-http'
  url: string
}

export interface PersistedStdioMcpServer extends PersistedMcpServerBase {
  transport: 'stdio'
  command: string
  args: readonly string[]
  cwd?: string
}

/**
 * The only MCP configuration shape that may be written to browser storage.
 * Authentication headers and process env are deliberately not representable.
 */
export type PersistedMcpServerConfig =
  | PersistedHttpMcpServer
  | PersistedStdioMcpServer

export interface McpAddServerDraft {
  name: string
  transport: McpTransport
  url: string
  command: string
  argsText: string
  cwd: string
  autoConnect: boolean
}

export type McpDraftField = keyof McpAddServerDraft
export type McpDraftErrors = Partial<Record<McpDraftField, string>>

export interface McpServerRuntime {
  status: McpServerStatus
  toolCount: number
  error?: string
}

export type McpServerOperation = 'connect' | 'reconnect' | 'disconnect' | 'remove'

export interface McpServerView extends McpServerRuntime {
  id: string
  name: string
  transport: McpTransport
  target: string
  autoConnect: boolean
  args: readonly string[]
  cwd?: string
}

export type McpHydrationState =
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'error'; error: string }

export const EMPTY_MCP_DRAFT: McpAddServerDraft = {
  name: '',
  transport: 'streamable-http',
  url: '',
  command: '',
  argsText: '',
  cwd: '',
  autoConnect: true,
}

export const DEFAULT_MCP_JSON_DRAFT = `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}`
