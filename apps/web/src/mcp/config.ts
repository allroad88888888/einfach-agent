import type { McpServerConfig } from '@einfach-agent/tools-mcp'
import {
  parseMcpEnvText,
  parseMcpHeadersText,
  sanitizeMcpEnv,
  sanitizeMcpHeaders,
} from './credentialFields'
import {
  hasControlCharacters,
  isSafeId,
  MAX_ARGS,
  MAX_COMMAND_LENGTH,
  MAX_CWD_LENGTH,
  MAX_NAME_LENGTH,
  normalizeOptionalText,
  normalizeText,
  parseArgsText,
  validateHttpUrl,
} from './configFieldValidation'
import { sanitizeStdioLaunchConsent } from './stdioLaunchConsent'
import type {
  McpAddServerDraft,
  McpDraftErrors,
  PersistedMcpServerConfig,
} from './types'

// parseArgsText 本身是字段级规则，实现住 configFieldValidation.ts；这里把它当作按 transport
// 分发管线公开契约的一部分继续从 './config' 导出，调用方（installFlow.ts、config.test.ts 等）
// 无需感知这次拆分。
export { parseArgsText } from './configFieldValidation'

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

  switch (draft.transport) {
    case 'streamable-http': {
      const result = validateHttpUrl(draft.url)
      if (result.error) errors.url = result.error
      // draft.headers（有值时）来自 JSON 导入，落笔前已经校验过，这里只管表单自己的文本框；
      // 两者不会同时有意义的内容（见 buildPersistedMcpConfig 的取值顺序）。
      const headers = parseMcpHeadersText(draft.headersText ?? '')
      if (headers.error) errors.headersText = headers.error
      break
    }
    case 'stdio': {
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
      const env = parseMcpEnvText(draft.envText ?? '')
      if (env.error) errors.envText = env.error
      break
    }
    default: {
      const exhaustive: never = draft.transport
      throw new Error(`Unsupported MCP transport: ${String(exhaustive)}`)
    }
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

export function buildPersistedMcpConfig(
  draft: McpAddServerDraft,
  id: string,
): PersistedMcpServerConfig {
  switch (draft.transport) {
    case 'streamable-http': {
      const { url } = validateHttpUrl(draft.url)
      if (!url) throw new Error('MCP 服务地址无效')
      // draft.headers 有值时来自 JSON 导入，落笔前已经在 jsonConfig.ts 用 sanitizeMcpHeaders
      // 校验过形状，直接透传、不再解析文本框；否则来自交互式表单，此刻解析 headersText
      // （validateMcpDraft 已经校验过，这里不会再拿到错误）。
      const headers = draft.headers ?? parseMcpHeadersText(draft.headersText ?? '').value
      return {
        id,
        name: draft.name.trim(),
        transport: 'streamable-http',
        url,
        ...(headers ? { headers } : {}),
        autoConnect: draft.autoConnect,
      }
    }
    case 'stdio': {
      const parsedArgs = parseArgsText(draft.argsText)
      if (!parsedArgs.args) throw new Error(parsedArgs.error ?? 'MCP 启动参数无效')
      const cwd = draft.cwd.trim()
      // draft.env 有值时来自 JSON 导入（同上，已在 jsonConfig.ts 校验过），否则解析 envText。
      const env = draft.env ?? parseMcpEnvText(draft.envText ?? '').value
      return {
        id,
        name: draft.name.trim(),
        transport: 'stdio',
        command: draft.command.trim(),
        args: parsedArgs.args,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
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
    default: {
      const exhaustive: never = draft.transport
      throw new Error(`Unsupported MCP transport: ${String(exhaustive)}`)
    }
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
  switch (config.transport) {
    case 'streamable-http':
      return {
        id: config.id,
        name: config.name,
        transport: 'streamable-http',
        url: config.url,
        ...(config.headers ? { headers: { ...config.headers } } : {}),
      }
    case 'stdio':
      return {
        id: config.id,
        name: config.name,
        transport: 'stdio',
        command: config.command,
        args: [...config.args],
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.env ? { env: { ...config.env } } : {}),
      }
    default: {
      const exhaustive: never = config
      throw new Error(`Unsupported MCP transport: ${String(exhaustive)}`)
    }
  }
}
