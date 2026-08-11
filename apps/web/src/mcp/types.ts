import type { McpServerStatus } from '@web-agent/tools-mcp'

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

/**
 * 用户对「在本机执行这条命令行」的一次确认（H2）。
 *
 * 【绑命令行，不绑服务】fingerprint 是 command / args / cwd 的规范化拼接（算法见
 * stdioLaunchConsent.ts）。任何一项被改过——将来的配置编辑界面、或者用户直接手改
 * `~/.webAgent/config.json`——都会与记录下来的指纹对不上，确认自动作废、下次再问一次。
 * 如果绑在服务 id 上，改完命令还顶着旧确认自动执行，正是这道门要防的事；而绑在命令行
 * 上是【数据模型自带】的失效，不依赖将来的编辑路径记得去清标记。
 */
export interface McpStdioLaunchConsent {
  /** 已确认过的那条命令行的指纹。 */
  readonly fingerprint: string
  /** 确认时间（epoch ms），只用于界面说明。 */
  readonly approvedAt: number
}

export interface PersistedStdioMcpServer extends PersistedMcpServerBase {
  transport: 'stdio'
  command: string
  args: readonly string[]
  cwd?: string
  /** 未确认过的服务没有这个字段；没有它就不允许起进程。 */
  launchConsent?: McpStdioLaunchConsent
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
