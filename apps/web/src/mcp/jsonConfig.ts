import { validateMcpDraft } from './config'
import { sanitizeMcpEnv, sanitizeMcpHeaders } from './credentialFields'
import { assertNoDuplicateObjectKeys } from './jsonConfigDuplicateKeys'
import { invalidJson, serviceLabel } from './jsonConfigErrors'
import { MCP_SETTINGS_MAX_SERVERS } from './persistence'
import { EMPTY_MCP_DRAFT, type McpAddServerDraft } from './types'

type JsonObject = Record<string, unknown>

const MAX_JSON_BYTES = 256 * 1_024
// env / headers 结构上一直允许出现（在 STDIO_FIELDS / HTTP_FIELDS 里），这样它们不会撞上
// assertAllowedFields 那条泛泛的「不支持的字段」错误；是否真的能用，由 serverObjectToDraft
// 里对 allowCredentials 的判断给出专门的中文提示（C3）。
const STDIO_FIELDS = new Set([
  'command',
  'args',
  'cwd',
  'type',
  'transport',
  'env',
])
const HTTP_FIELDS = new Set([
  'url',
  'type',
  'transport',
  'headers',
])
const SINGLE_STDIO_FIELDS = new Set(['name', ...STDIO_FIELDS])
const SINGLE_HTTP_FIELDS = new Set(['name', ...HTTP_FIELDS])

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertAllowedFields(
  name: string,
  input: JsonObject,
  allowed: ReadonlySet<string>,
): void {
  const unsupported = Object.keys(input).filter((field) => !allowed.has(field))
  if (unsupported.length > 0) {
    if (unsupported.includes('autoConnect')) {
      throw new Error(`${serviceLabel(name)}不支持 autoConnect；JSON 导入后统一手动连接`)
    }
    throw new Error(`${serviceLabel(name)}包含不支持的字段：${unsupported.join('、')}`)
  }
}

function readDeclaredTransport(name: string, input: JsonObject): 'stdio' | 'streamable-http' | undefined {
  const normalize = (value: unknown, field: string): 'stdio' | 'streamable-http' | undefined => {
    if (value === undefined) return undefined
    if (value === 'stdio') return 'stdio'
    if (value === 'http' || value === 'streamable-http') return 'streamable-http'
    throw new Error(`${serviceLabel(name)}的 ${field} 仅支持 stdio、http 或 streamable-http`)
  }

  const type = normalize(input.type, 'type')
  const transport = normalize(input.transport, 'transport')
  if (type && transport && type !== transport) {
    throw new Error(`${serviceLabel(name)}的 type 与 transport 相互冲突`)
  }
  return type ?? transport
}

/**
 * 取出 stdio 的 env / http 的 headers（C3）。字段不存在时返回 undefined，不落一个空对象。
 *
 * 【为什么在这里就报「仅桌面端支持」而不是留给后面的 sanitize】不这样做的话，浏览器宿主会
 * 拿到 sanitizeMcpEnv 的形状校验错误（比如「键名不合法」），这句话对着一份浏览器压根不该
 * 接受的字段毫无意义，还会让用户以为把 env 写对了就能在浏览器里用。必须先问「这个宿主能不
 * 能存」，再问「存的内容对不对」。
 */
function readCredentialField(
  label: string,
  input: JsonObject,
  field: 'env' | 'headers',
  allowCredentials: boolean,
  sanitize: (value: unknown) => { ok: boolean; value?: Readonly<Record<string, string>> },
): Readonly<Record<string, string>> | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, field)) return undefined
  if (!allowCredentials) {
    throw new Error(`${label}的凭据字段仅桌面端支持，请删除 headers/env 后再导入`)
  }
  const sanitized = sanitize(input[field])
  if (!sanitized.ok) {
    throw new Error(`${label}的 ${field} 格式不正确`)
  }
  return sanitized.value
}

function serverObjectToDraft(
  name: string,
  input: JsonObject,
  allowNameField: boolean,
  allowCredentials: boolean,
): McpAddServerDraft {
  const label = serviceLabel(name)
  const hasCommand = Object.prototype.hasOwnProperty.call(input, 'command')
  const hasUrl = Object.prototype.hasOwnProperty.call(input, 'url')
  if (hasCommand && hasUrl) {
    throw new Error(`${label}不能同时配置 command 和 url`)
  }
  if (!hasCommand && !hasUrl) {
    throw new Error(`${label}必须配置 command 或 url`)
  }

  const inferredTransport = hasCommand ? 'stdio' : 'streamable-http'
  const declaredTransport = readDeclaredTransport(name, input)
  if (declaredTransport && declaredTransport !== inferredTransport) {
    throw new Error(`${label}声明的传输方式与 ${hasCommand ? 'command' : 'url'} 不匹配`)
  }

  assertAllowedFields(
    name,
    input,
    allowNameField
      ? inferredTransport === 'stdio'
        ? SINGLE_STDIO_FIELDS
        : SINGLE_HTTP_FIELDS
      : inferredTransport === 'stdio'
        ? STDIO_FIELDS
        : HTTP_FIELDS,
  )

  let draft: McpAddServerDraft
  if (inferredTransport === 'stdio') {
    if (typeof input.command !== 'string') {
      throw new Error(`${label}的 command 必须是字符串`)
    }
    if (input.args !== undefined && !Array.isArray(input.args)) {
      throw new Error(`${label}的 args 必须是字符串数组`)
    }
    const args = input.args ?? []
    if (!(args as unknown[]).every((arg) => typeof arg === 'string')) {
      throw new Error(`${label}的 args 必须全部是字符串`)
    }
    if ((args as string[]).some((arg) => !arg.trim())) {
      throw new Error(`${label}的 args 不能包含空字符串`)
    }
    if (input.cwd !== undefined && typeof input.cwd !== 'string') {
      throw new Error(`${label}的 cwd 必须是字符串`)
    }
    const env = readCredentialField(label, input, 'env', allowCredentials, sanitizeMcpEnv)
    draft = {
      ...EMPTY_MCP_DRAFT,
      name,
      transport: 'stdio',
      command: input.command,
      argsText: (args as string[]).join('\n'),
      cwd: (input.cwd as string | undefined) ?? '',
      // Starting a local process always remains an explicit user action.
      autoConnect: false,
      ...(env ? { env } : {}),
    }
  } else {
    if (typeof input.url !== 'string') {
      throw new Error(`${label}的 url 必须是字符串`)
    }
    const headers = readCredentialField(label, input, 'headers', allowCredentials, sanitizeMcpHeaders)
    draft = {
      ...EMPTY_MCP_DRAFT,
      name,
      transport: 'streamable-http',
      url: input.url,
      // Importing JSON only stages configuration. Every imported server must
      // be connected explicitly after the user has reviewed it.
      autoConnect: false,
      ...(headers ? { headers } : {}),
    }
  }

  const validation = validateMcpDraft(draft)
  if (!validation.valid) {
    throw new Error(`${label}：${Object.values(validation.errors).join('；')}`)
  }
  return draft
}

/**
 * Parse the common MCP JSON format into the same drafts used by the settings
 * form. Supported shapes:
 *   { "mcpServers": { "name": { "command": "...", "args": [] } } }
 *   { "name": "name", "command": "...", "args": [] }
 *
 * `allowCredentials`：这个宿主能不能落盘 headers/env（见 McpSettingsCapabilities.credentials，
 * 桌面为 true）。浏览器宿主带着这两个字段导入时直接报错，不静默剥离——静默剥离会让用户以为
 * 凭据已经保存，实际上服务器连接从一开始就没有认证。
 */
export function parseMcpJsonConfig(
  jsonText: string,
  options?: { allowCredentials?: boolean },
): readonly McpAddServerDraft[] {
  const allowCredentials = options?.allowCredentials === true
  if (new TextEncoder().encode(jsonText).byteLength > MAX_JSON_BYTES) {
    throw new Error('MCP JSON 配置不能超过 256 KiB')
  }
  if (!jsonText.trim()) throw new Error('请输入 MCP JSON 配置')
  assertNoDuplicateObjectKeys(jsonText)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    invalidJson()
  }
  if (!isJsonObject(parsed)) {
    throw new Error('MCP JSON 顶层必须是对象')
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error('MCP 配置不能为空')
  }

  let entries: [string, unknown][]
  let singleServer = false
  if (Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')) {
    const topLevelFields = Object.keys(parsed).filter((field) => field !== 'mcpServers')
    if (topLevelFields.length > 0) {
      throw new Error(`MCP JSON 顶层包含不支持的字段：${topLevelFields.join('、')}`)
    }
    if (!isJsonObject(parsed.mcpServers)) {
      throw new Error('mcpServers 必须是对象')
    }
    entries = Object.entries(parsed.mcpServers)
    if (entries.length === 0) throw new Error('mcpServers 中至少需要一个服务')
  } else {
    singleServer = true
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      throw new Error('单个 MCP 服务配置必须提供 name')
    }
    entries = [[parsed.name, parsed]]
  }

  if (entries.length > MCP_SETTINGS_MAX_SERVERS) {
    throw new Error(`一次最多导入 ${MCP_SETTINGS_MAX_SERVERS} 个 MCP 服务`)
  }

  const normalizedNames = new Set<string>()
  return entries.map(([rawName, value]) => {
    const name = rawName.trim()
    const normalizedName = name.toLowerCase()
    if (normalizedNames.has(normalizedName)) {
      throw new Error(`MCP 服务名称重复：“${name}”`)
    }
    normalizedNames.add(normalizedName)
    if (!isJsonObject(value)) {
      throw new Error(`${serviceLabel(name)}的配置必须是对象`)
    }
    return serverObjectToDraft(name, value, singleServer, allowCredentials)
  })
}
