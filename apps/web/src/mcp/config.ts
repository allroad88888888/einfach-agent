import type { McpServerConfig } from '@web-agent/tools-mcp'
import { sanitizeMcpEnv, sanitizeMcpHeaders } from './credentialFields'
import { sanitizeStdioLaunchConsent } from './stdioLaunchConsent'
import type {
  McpAddServerDraft,
  McpDraftErrors,
  PersistedMcpServerConfig,
} from './types'

const MAX_NAME_LENGTH = 80
const MAX_URL_LENGTH = 2_048
const MAX_COMMAND_LENGTH = 512
const MAX_CWD_LENGTH = 1_024
const MAX_ARG_LENGTH = 1_024
const MAX_ARGS = 64
const MAX_ID_LENGTH = 96

const SECRET_KEY_PART = /(?:^|[-_.])(?:token|secret|password|passphrase|api[-_]?key|authorization|authentication|auth|credential|private[-_]?key)(?:$|[-_.])/i
const UNSAFE_ARGUMENT_KEY = /(?:^|[-_.])(?:headers?|env(?:ironment)?)(?:$|[-_.])/i
const SECRET_VALUE = /(?:sk-[a-z0-9_-]{6,}|gh[oprsu]_[a-z0-9_]{8,}|glpat-[a-z0-9_-]{8,}|xox[a-z]-[a-z0-9-]{8,}|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i

function normalizeKeyParts(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
}

function isSecretKey(value: string): boolean {
  return SECRET_KEY_PART.test(normalizeKeyParts(value))
}

function hasUnsafeArgument(arg: string): boolean {
  const optionMatch = /^--?([^=\s]+)/.exec(arg)
  if (optionMatch) {
    const optionKey = normalizeKeyParts(optionMatch[1] ?? '')
    if (isSecretKey(optionKey) || UNSAFE_ARGUMENT_KEY.test(optionKey)) return true
  }

  const assignmentMatch = /^([^=\s]+)=/.exec(arg)
  if (assignmentMatch && isSecretKey(assignmentMatch[1] ?? '')) return true

  return /(?:^|[=:\s])bearer\s+/i.test(arg) || SECRET_VALUE.test(arg)
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function normalizeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || hasControlCharacters(normalized)) {
    return undefined
  }
  return normalized
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeText(value, maxLength)
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
}

function validateHttpUrl(raw: string): { url?: string; error?: string } {
  const value = raw.trim()
  if (!value) return { error: '请输入服务地址' }
  if (value.length > MAX_URL_LENGTH || hasControlCharacters(value)) {
    return { error: '服务地址格式不正确' }
  }

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: '服务地址仅支持 http:// 或 https://' }
    }
    if (parsed.username || parsed.password) {
      return { error: '请勿把账号或凭据写入服务地址' }
    }
    if (parsed.hash) {
      return { error: '服务地址不能包含 URL 片段' }
    }
    if (parsed.search) {
      return { error: '服务地址不能包含查询参数，请使用无凭据的基础地址' }
    }
    return { url: parsed.toString() }
  } catch {
    return { error: '请输入完整的 http(s) 服务地址' }
  }
}

export function parseArgsText(argsText: string): { args?: string[]; error?: string } {
  const args = argsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (args.length > MAX_ARGS) {
    return { error: `启动参数最多 ${MAX_ARGS} 项` }
  }
  if (args.some((arg) => arg.length > MAX_ARG_LENGTH || hasControlCharacters(arg))) {
    return { error: '启动参数过长或包含不可见字符' }
  }
  if (args.some(hasUnsafeArgument)) {
    // 拒绝的理由不再是「没地方存凭据」（现在有了），而是 args 本来就不该存凭据：启动参数
    // 会出现在本机进程列表里，任何进程都看得到。
    return {
      error: '启动参数不能包含疑似 token、密钥或密码；请改用 env 环境变量字段保存凭据'
        + '（HTTP 服务用 headers 请求头字段）',
    }
  }
  return { args }
}

export function validateMcpDraft(draft: McpAddServerDraft): {
  valid: boolean
  errors: McpDraftErrors
} {
  const errors: McpDraftErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = '请输入服务名称'
  else if (name.length > MAX_NAME_LENGTH || hasControlCharacters(name)) {
    errors.name = `服务名称不能超过 ${MAX_NAME_LENGTH} 个字符`
  }

  if (draft.transport === 'streamable-http') {
    const result = validateHttpUrl(draft.url)
    if (result.error) errors.url = result.error
  } else {
    const command = draft.command.trim()
    if (!command) errors.command = '请输入启动命令'
    else if (command.length > MAX_COMMAND_LENGTH || hasControlCharacters(command)) {
      errors.command = '启动命令格式不正确'
    }
    const args = parseArgsText(draft.argsText)
    if (args.error) errors.argsText = args.error
    const cwd = draft.cwd.trim()
    if (cwd && (cwd.length > MAX_CWD_LENGTH || hasControlCharacters(cwd))) {
      errors.cwd = '工作目录格式不正确'
    }
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

export function buildPersistedMcpConfig(
  draft: McpAddServerDraft,
  id: string,
): PersistedMcpServerConfig {
  if (draft.transport === 'streamable-http') {
    const { url } = validateHttpUrl(draft.url)
    if (!url) throw new Error('MCP 服务地址无效')
    return {
      id,
      name: draft.name.trim(),
      transport: 'streamable-http',
      url,
      // 原样透传：draft.headers 只有 JSON 导入通道会填，且落笔前已经在 jsonConfig.ts
      // 用 sanitizeMcpHeaders 校验过形状，这里不必再校验一遍。
      ...(draft.headers ? { headers: draft.headers } : {}),
      autoConnect: draft.autoConnect,
    }
  }

  const parsedArgs = parseArgsText(draft.argsText)
  if (!parsedArgs.args) throw new Error(parsedArgs.error ?? 'MCP 启动参数无效')
  const cwd = draft.cwd.trim()
  return {
    id,
    name: draft.name.trim(),
    transport: 'stdio',
    command: draft.command.trim(),
    args: parsedArgs.args,
    ...(cwd ? { cwd } : {}),
    // 原样透传：draft.env 只有 JSON 导入通道会填，且落笔前已经在 jsonConfig.ts 用
    // sanitizeMcpEnv 校验过形状，这里不必再校验一遍。
    ...(draft.env ? { env: draft.env } : {}),
    // The persisted field itself may legitimately be true (H1) — stdio is a
    // normal boolean preference at the data-model layer. Whether that
    // preference is ever allowed to actually start a local process is a
    // separate question, answered by the launch consent recorded on the
    // config (H2, see stdioLaunchConsent.ts). A freshly built config never
    // carries one: consent can only come from the user answering the prompt
    // for a concrete command line, never from a form draft.
    autoConnect: draft.autoConnect,
  }
}

export function sanitizePersistedMcpConfig(value: unknown): PersistedMcpServerConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (!isSafeId(input.id)) return undefined
  const name = normalizeText(input.name, MAX_NAME_LENGTH)
  if (!name) return undefined
  // Persisted data may be legacy, malformed, or user-controlled. Starting a
  // network connection must require an explicit stored opt-in.
  const autoConnect = typeof input.autoConnect === 'boolean' ? input.autoConnect : false

  if (input.transport === 'streamable-http') {
    if (typeof input.url !== 'string') return undefined
    const { url } = validateHttpUrl(input.url)
    if (!url) return undefined
    // 形状非法的凭据整条丢弃这个服务，而不是只丢掉那一个条目：留下来的会是一份「看着已保存、
    // 连上去却没有认证」的配置，排查成本远高于服务直接消失。与下面 cwd 的处理同一口径。
    const headers = sanitizeMcpHeaders(input.headers)
    if (!headers.ok) return undefined
    return {
      id: input.id,
      name,
      transport: 'streamable-http',
      url,
      ...(headers.value ? { headers: headers.value } : {}),
      autoConnect,
    }
  }

  if (input.transport !== 'stdio') return undefined
  const command = normalizeText(input.command, MAX_COMMAND_LENGTH)
  if (!command || !Array.isArray(input.args) || input.args.length > MAX_ARGS) return undefined
  if (!input.args.every((arg) => typeof arg === 'string')) return undefined
  const parsedArgs = parseArgsText((input.args as string[]).join('\n'))
  if (!parsedArgs.args) return undefined
  const cwd = normalizeOptionalText(input.cwd, MAX_CWD_LENGTH)
  if (input.cwd !== undefined && !cwd) return undefined
  const env = sanitizeMcpEnv(input.env)
  if (!env.ok) return undefined
  // Shape check only: whether this consent still matches the command above is
  // decided in exactly one place (mayLaunchMcpServer). A stored consent whose
  // fingerprint no longer matches is kept as-is and simply stops authorizing
  // anything, so re-editing the command back restores it rather than silently
  // requiring a second confirmation.
  const launchConsent = sanitizeStdioLaunchConsent(input.launchConsent)
  return {
    id: input.id,
    name,
    transport: 'stdio',
    command,
    args: parsedArgs.args,
    ...(cwd ? { cwd } : {}),
    ...(env.value ? { env: env.value } : {}),
    ...(launchConsent ? { launchConsent } : {}),
    // Round-trip whatever opt-in was actually stored (see `autoConnect`
    // above), instead of silently downgrading a legitimately saved
    // true back to false. Not connecting on that value yet is a runtime
    // decision made in service.ts, not a sanitize-time one.
    autoConnect,
  }
}

/**
 * 把持久化白名单转成 core 管理器的连接配置。逐字段显式列出（而不是整个对象扔过去），
 * 保证只有白名单里的字段能进到连接层——launchConsent 这类纯应用层记录不该出现在协议侧。
 *
 * 【headers / env 在这里透传】它们本来就是给连接用的凭据（C1）。曾经刻意不透传是为了拦住
 *「凭据泄进 localStorage」，那道防线现在由 localStorage 宿主自己的剥离承担
 * （persistence.ts 的 createMcpConfigStorage），不再靠在这里断供。
 * 两张表都复制一份：管理器会长期持有配置并在重连时复用，共享引用等于让上游改配置能改到
 * 一条已经连上的连接。
 */
export function toManagerConfig(config: PersistedMcpServerConfig): McpServerConfig {
  if (config.transport === 'streamable-http') {
    return {
      id: config.id,
      name: config.name,
      transport: 'streamable-http',
      url: config.url,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    }
  }
  return {
    id: config.id,
    name: config.name,
    transport: 'stdio',
    command: config.command,
    args: [...config.args],
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
  }
}
