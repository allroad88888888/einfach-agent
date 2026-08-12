// MCP 配置里的两个凭据字段（C1）：streamable-http 的 `headers`、stdio 的 `env`。
//
// 【为什么单独一个文件】这两个字段是持久化白名单里唯一「值本身就是秘密」的部分。它们的校验
// 规则（键的字符集、条数与长度上限、控制字符）和 config.ts 里那些「名称 / 地址 / 命令行」的
// 校验不在一个层面：那边判的是"格式对不对"，这边判的是"这份秘密的形状安不安全"。塞进
// config.ts 只会让那个文件顶破行数上限，也让「凭据怎么净化、怎么剥离」散进别人的文件里。
//
// 【分层】净化（sanitizeMcpHeaders / sanitizeMcpEnv）属于**所有宿主共用**的白名单：桌面配置
// 文件 `~/.webAgent/config.json` 是凭据的唯一落点，用户手写进去的 headers/env 要靠它收成合法
// 形状。剥离（stripMcpCredentialFields）只属于 localStorage 宿主——浏览器存储永远不落凭据，
// 调用点在 persistence.ts 的 createMcpConfigStorage 里，且只在那里。
//
// 【不做秘密探测】值就是用户自己的凭据，长得像 token 恰恰是它正常的样子，所以这里不套用
// config.ts 对启动参数的那套秘密特征匹配。只保证形状安全：控制字符是 header 注入（CR/LF）与
// 环境变量截断（NUL）的入口，没有任何正当用途，一律拒。

import type { PersistedMcpServerConfig } from './types'

/** 条数与长度上限：够用即可。上限的意义是让被改坏的配置文件不能撑爆内存或请求头。 */
const MAX_ENTRIES = 32
const MAX_KEY_LENGTH = 128
const MAX_VALUE_LENGTH = 4_096

/**
 * HTTP 字段名的合法字符集（RFC 9110 的 token）。
 *
 * Authorization、X-Api-Key 这类敏感键是**允许**的——存凭据正是这个字段存在的理由，这里
 * 不复用 config.ts 的秘密键名匹配。
 */
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** POSIX 环境变量名。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// 与 config.ts 里同名判定同一条规则。刻意各留一份而不是互相 import：config.ts 已经 import 了
// 本文件，反向再 import 会造出模块环，为一行正则不值得。
function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * 净化结果。
 *
 * - `{ ok: true }`：字段不存在，或者是一张空表——两者都当作"没有凭据"，不落地空对象。
 * - `{ ok: true, value }`：合法且非空。
 * - `{ ok: false }`：形状非法。调用方应当整条丢弃这个服务配置（理由见 config.ts 的调用点）。
 */
export type McpCredentialFieldResult =
  | { readonly ok: true; readonly value?: Readonly<Record<string, string>> }
  | { readonly ok: false }

const ABSENT: McpCredentialFieldResult = { ok: true }
const INVALID: McpCredentialFieldResult = { ok: false }

function sanitizeCredentialMap(
  value: unknown,
  isValidKey: (key: string) => boolean,
): McpCredentialFieldResult {
  if (value === undefined || value === null) return ABSENT
  if (typeof value !== 'object' || Array.isArray(value)) return INVALID

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return ABSENT
  if (entries.length > MAX_ENTRIES) return INVALID

  for (const [key, entryValue] of entries) {
    if (key.length > MAX_KEY_LENGTH || !isValidKey(key)) return INVALID
    if (typeof entryValue !== 'string') return INVALID
    if (entryValue.length > MAX_VALUE_LENGTH) return INVALID
    if (hasControlCharacters(entryValue)) return INVALID
  }

  // 用 Object.fromEntries 而不是逐个赋值：`__proto__` 是合法的 HTTP token，`obj['__proto__'] = v`
  // 会走原型 setter（键就此消失，甚至改掉原型），而 fromEntries 建的是普通自有属性。
  // 值不做 trim：前后空白在环境变量里可能是凭据的一部分，净化不该悄悄改内容。
  return { ok: true, value: Object.fromEntries(entries as [string, string][]) }
}

/** Streamable HTTP 的认证头。键按 HTTP 字段名校验。 */
export function sanitizeMcpHeaders(value: unknown): McpCredentialFieldResult {
  return sanitizeCredentialMap(value, (key) => HTTP_HEADER_NAME.test(key))
}

/** stdio 子进程的环境变量。键按 POSIX 环境变量名校验。 */
export function sanitizeMcpEnv(value: unknown): McpCredentialFieldResult {
  return sanitizeCredentialMap(value, (key) => ENV_NAME.test(key))
}

/**
 * 凭据字段在设置表单里的**文本形态**（C2）：多行 `KEY=VALUE`，与 config.ts 里 argsText
 * 的"文本草稿、提交时才解析"是同一套路——用户看到的是一整块可编辑文本，不是一行一个输入框
 * 拼出来的表格。放在这个文件而不是 config.ts：这两个 parse 函数解析完立刻调用上面的
 * sanitizeMcpHeaders / sanitizeMcpEnv 做形状校验，是「凭据字段」这一个概念的两种表示之间
 * 的转换，不是 config.ts 里那些"名称 / 地址 / 命令行"格式校验的同类。
 */
export type McpCredentialTextParseResult =
  | { readonly value?: Readonly<Record<string, string>>; readonly error?: undefined }
  | { readonly value?: undefined; readonly error: string }

/**
 * 逐行拆成 KEY=VALUE。空文本（或全是空白行）视为"没有条目"而不是错误——表单里留空是
 * 最常见的情况。找不到 `=`、或 `=` 前面是空字符串，都判定为格式错误，把原始行带进提示里
 * 方便用户定位。值不做 trim（与 sanitizeCredentialMap 同一理由：前后空白可能是凭据本身）。
 */
function parseCredentialLines(text: string): { entries?: Record<string, string>; error?: string } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return {}

  const entries: Record<string, string> = {}
  for (const line of lines) {
    const separatorIndex = line.indexOf('=')
    const key = separatorIndex > 0 ? line.slice(0, separatorIndex).trim() : ''
    if (!key) {
      return { error: `格式应为每行一个“键=值”，无法解析：“${line}”` }
    }
    entries[key] = line.slice(separatorIndex + 1)
  }
  return { entries }
}

/** 把表单里多行文本解析成 streamable-http 的认证头；形状校验复用 sanitizeMcpHeaders。 */
export function parseMcpHeadersText(text: string): McpCredentialTextParseResult {
  const parsed = parseCredentialLines(text)
  if (parsed.error) return { error: `请求头${parsed.error}` }
  if (!parsed.entries) return {}
  const sanitized = sanitizeMcpHeaders(parsed.entries)
  if (!sanitized.ok) {
    return { error: '请求头字段名或值不合法（字段名需符合 HTTP 请求头命名规则，且不能包含控制字符）' }
  }
  return { value: sanitized.value }
}

/** 把表单里多行文本解析成 stdio 子进程环境变量；形状校验复用 sanitizeMcpEnv。 */
export function parseMcpEnvText(text: string): McpCredentialTextParseResult {
  const parsed = parseCredentialLines(text)
  if (parsed.error) return { error: `环境变量${parsed.error}` }
  if (!parsed.entries) return {}
  const sanitized = sanitizeMcpEnv(parsed.entries)
  if (!sanitized.ok) {
    return { error: '环境变量名或值不合法（变量名需符合 POSIX 命名规则，且不能包含控制字符）' }
  }
  return { value: sanitized.value }
}

/**
 * 去掉配置里的凭据字段，得到一份可以写进浏览器存储的副本。
 *
 * 只有 localStorage 宿主需要它：凭据的唯一落点是桌面配置文件，浏览器存储里的东西任何脚本、
 * 任何看得到这台机器 profile 的人都读得到。没有凭据字段时原样返回，避免无谓的对象复制。
 */
export function stripMcpCredentialFields(
  config: PersistedMcpServerConfig,
): PersistedMcpServerConfig {
  if (config.transport === 'streamable-http') {
    if (!config.headers) return config
    const { headers: _headers, ...rest } = config
    return rest
  }
  if (!config.env) return config
  const { env: _env, ...rest } = config
  return rest
}
