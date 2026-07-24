import { validateMcpDraft } from './config'
import { MCP_SETTINGS_MAX_SERVERS } from './persistence'
import { EMPTY_MCP_DRAFT, type McpAddServerDraft } from './types'

type JsonObject = Record<string, unknown>

const MAX_JSON_BYTES = 256 * 1_024
const STDIO_FIELDS = new Set([
  'command',
  'args',
  'cwd',
  'type',
  'transport',
])
const HTTP_FIELDS = new Set([
  'url',
  'type',
  'transport',
])
const SINGLE_STDIO_FIELDS = new Set(['name', ...STDIO_FIELDS])
const SINGLE_HTTP_FIELDS = new Set(['name', ...HTTP_FIELDS])

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serviceLabel(name: string): string {
  const visible = name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80)
  return `MCP 服务“${visible || '未命名'}”`
}

function invalidJson(): never {
  throw new Error('MCP JSON 格式无效')
}

/**
 * JSON.parse silently keeps the final value when an object contains duplicate
 * keys. Reject them before parsing so a pasted MCP config cannot hide a server
 * or replace a security-relevant field.
 */
function assertNoDuplicateObjectKeys(source: string): void {
  let cursor = 0

  const skipWhitespace = (): void => {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
  }

  const parseString = (): string => {
    if (source[cursor] !== '"') invalidJson()
    const start = cursor
    cursor += 1
    while (cursor < source.length) {
      const char = source[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '"') {
        cursor += 1
        try {
          return JSON.parse(source.slice(start, cursor)) as string
        } catch {
          invalidJson()
        }
      }
      cursor += 1
    }
    invalidJson()
  }

  const duplicateKeyError = (path: readonly string[], key: string): never => {
    if (path.length === 1 && path[0] === 'mcpServers') {
      throw new Error(`MCP 服务名称重复：“${key}”`)
    }
    if (path.length >= 2 && path[0] === 'mcpServers') {
      throw new Error(`${serviceLabel(path[1] ?? '')}存在重复字段“${key}”`)
    }
    throw new Error(`MCP JSON 对象存在重复字段“${key}”`)
  }

  const parseValue = (path: readonly string[]): void => {
    skipWhitespace()
    const char = source[cursor]
    if (char === '{') {
      cursor += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (source[cursor] === '}') {
        cursor += 1
        return
      }
      while (cursor < source.length) {
        skipWhitespace()
        const key = parseString()
        if (keys.has(key)) duplicateKeyError(path, key)
        keys.add(key)
        skipWhitespace()
        if (source[cursor] !== ':') invalidJson()
        cursor += 1
        parseValue([...path, key])
        skipWhitespace()
        if (source[cursor] === '}') {
          cursor += 1
          return
        }
        if (source[cursor] !== ',') invalidJson()
        cursor += 1
      }
      invalidJson()
    }
    if (char === '[') {
      cursor += 1
      skipWhitespace()
      if (source[cursor] === ']') {
        cursor += 1
        return
      }
      while (cursor < source.length) {
        parseValue(path)
        skipWhitespace()
        if (source[cursor] === ']') {
          cursor += 1
          return
        }
        if (source[cursor] !== ',') invalidJson()
        cursor += 1
      }
      invalidJson()
    }
    if (char === '"') {
      parseString()
      return
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      source.slice(cursor),
    )
    if (!primitive) invalidJson()
    cursor += primitive[0].length
  }

  parseValue([])
  skipWhitespace()
  if (cursor !== source.length) invalidJson()
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

function serverObjectToDraft(
  name: string,
  input: JsonObject,
  allowNameField: boolean,
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
    draft = {
      ...EMPTY_MCP_DRAFT,
      name,
      transport: 'stdio',
      command: input.command,
      argsText: (args as string[]).join('\n'),
      cwd: (input.cwd as string | undefined) ?? '',
      // Starting a local process always remains an explicit user action.
      autoConnect: false,
    }
  } else {
    if (typeof input.url !== 'string') {
      throw new Error(`${label}的 url 必须是字符串`)
    }
    draft = {
      ...EMPTY_MCP_DRAFT,
      name,
      transport: 'streamable-http',
      url: input.url,
      // Importing JSON only stages configuration. Every imported server must
      // be connected explicitly after the user has reviewed it.
      autoConnect: false,
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
 */
export function parseMcpJsonConfig(jsonText: string): readonly McpAddServerDraft[] {
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
    return serverObjectToDraft(name, value, singleServer)
  })
}
