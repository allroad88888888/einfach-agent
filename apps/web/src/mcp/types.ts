import type { McpServerStatus } from '@web-agent/tools-mcp'
import type { McpLastKnownTools } from './toolNameCache'

export type McpTransport = 'streamable-http' | 'stdio'
export type McpPersistenceMode = 'persistent' | 'temporary'
export type McpAddMode = 'form' | 'json'

export interface McpSettingsCapabilities {
  stdio: boolean
  /**
   * 这个宿主能不能落盘凭据字段（C3）：streamable-http 的 headers、stdio 的 env。
   *
   * 【为什么不复用 stdio】两者当前都只在桌面为 true，但回答的是不同问题——stdio 问
   * 「能不能起本机子进程」，这个问「凭据能不能安全落盘」。凭据的唯一落点是桌面配置文件
   * `~/.webAgent/config.json`（见 credentialFields.ts），localStorage 宿主读写两端都会剥离，
   * 因此 JSON 导入通道必须能在浏览器上把 headers/env 挡在门外并明确报错，而不是静默丢字段。
   */
  credentials: boolean
}

interface PersistedMcpServerBase {
  id: string
  name: string
  autoConnect: boolean
}

export interface PersistedHttpMcpServer extends PersistedMcpServerBase {
  transport: 'streamable-http'
  url: string
  /**
   * 静态认证头（C1）。值就是凭据本身，因此只允许落在桌面配置文件里；写浏览器存储的那条
   * 路径会剥掉这个字段（见 credentialFields.ts 与 persistence.ts）。
   */
  headers?: Readonly<Record<string, string>>
}

/**
 * 用户对「在本机执行这条命令行」的一次确认（H2）。
 *
 * 【绑命令行，不绑服务】fingerprint 是 command / args / cwd 的规范化拼接，`env` 存在时作为
 * 第四项一并纳入（没有 env 的存量配置指纹不变，算法见 stdioLaunchConsent.ts）。任何一项被
 * 改过——将来的配置编辑界面、或者用户直接手改 `~/.webAgent/config.json`——都会与记录下来
 * 的指纹对不上，确认自动作废、下次再问一次。
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
  /**
   * 子进程环境变量（C1）。凭据走这里，不走 args——启动参数会出现在进程列表里，而且
   * config.ts 至今拒绝疑似 token 的启动参数。与 headers 同样只落桌面配置文件。
   */
  env?: Readonly<Record<string, string>>
  /** 未确认过的服务没有这个字段；没有它就不允许起进程。 */
  launchConsent?: McpStdioLaunchConsent
}

/**
 * MCP 配置的持久化白名单：没写在这里的字段一律不落盘。
 *
 * 【凭据字段的宿主差异】headers / env 在这个模型里是**可表示**的，但只有桌面配置文件
 * （`~/.webAgent/config.json`）真的存它们；localStorage 宿主在读写两端都会剥掉
 * （见 persistence.ts 的 createMcpConfigStorage）。
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
  /**
   * 凭据字段的**最终形态**（C3）。唯一产出方是 JSON 导入通道（jsonConfig.ts）：解析时已经
   * 用 credentialFields.ts 的 sanitizeMcpHeaders/sanitizeMcpEnv 校验过形状，
   * buildPersistedMcpConfig 见它有值就直接透传，不会再解析下面的文本字段。
   */
  headers?: Readonly<Record<string, string>>
  env?: Readonly<Record<string, string>>
  /**
   * 凭据字段的**表单文本形态**（C2）。交互式表单（McpCredentialField 组件）是唯一的
   * 产出方：多行 `KEY=VALUE`，和 argsText 同一套"文本草稿、提交时才解析"的路子，解析规则见
   * credentialFields.ts 的 parseMcpHeadersText / parseMcpEnvText。headersText 对应
   * streamable-http 的 headers，envText 对应 stdio 的 env；只在上面的 headers/env 没有
   * 预先给出时（即不是走 JSON 导入）才会被 buildPersistedMcpConfig 拿去解析。
   * 只在宿主支持落盘凭据（McpSettingsCapabilities.credentials）时表单里的输入框才可编辑；
   * 浏览器宿主下这两个字段恒为空文本。
   */
  headersText?: string
  envText?: string
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
  /**
   * 这个服务【上次已知】的工具清单（B5）。与 McpServerRuntime.toolCount 不是一回事：
   * toolCount 是当前连接的真实工具数，这里是历史，且自带探测时刻。
   *
   * 【没有这个字段 ≠ 探测到 0 个工具】从未探测过的服务根本没有它；呈现层必须把这两种
   * 情况说成不同的话（见 mcpLastKnownToolsText.ts）。
   */
  lastKnownTools?: McpLastKnownTools
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
  headersText: '',
  envText: '',
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
