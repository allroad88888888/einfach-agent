// 把 `Record<string, unknown>` 收窄成具体类型的那几个原子操作
// ---------------------------------------------------------------------------
// 这一层在 Rust 侧**不存在**：Tauri 用 serde 反序列化命令入参，形状不对时在进入
// `#[tauri::command]` 之前就失败了，失败形态是 Tauri 自己的反序列化错误、不是 `McpCommandError`。
// Node 这张路由表没有那一层——handler 拿到的就是 `Record<string, unknown>`，而这张表要挂在
// `POST /api/invoke/:command` 后面，那条路上的载荷是**外部输入**。
//
// 所以这里的失败一律整形成 `invalid_input` 的 `McpCommandError`：调用方（tools/mcp 的失败分类器）
// 只认得这套 kind，冒出一个裸 TypeError 会被当成「宿主自己崩了」而不是「你的载荷不对」。
//
// 【为什么判缺省只看值、不用 `'key' in args`】core 的 `toTauriInput` 整份对象字面量返回，
// 可选项无值时**键存在且为 undefined**。进程内注入原样到达，走 HTTP 时 `JSON.stringify` 会把
// 这些键丢掉——同一份入参在两种传输下键集合不同。用 `in` 判会写出「CLI 上能跑、上 server 就变」
// 的 bug，而且只在某个可选参数没传时才现形。

import { McpCommandError } from './errors'

function invalid(message: string): McpCommandError {
  return new McpCommandError('invalid_input', message)
}

/** 普通对象（排除 null 与数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`\`${field}\` must be an object`)
  return value
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(`\`${field}\` must be a string`)
  return value
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field)
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw invalid(`\`${field}\` must be a boolean`)
  return value
}

/**
 * 非负整数。Rust 那边这些字段是 `u64`，serde 会拒掉负数、小数与超范围的值；这里补齐同一道门。
 *
 * 上界用 `Number.MAX_SAFE_INTEGER` 而不是 u64 的 2^64-1：超过安全整数范围的 JSON 数字在
 * `JSON.parse` 之后已经**丢过精度**了，放行等于把一个已经不是原值的数字当成用户的意思。
 */
export function optionalUnsignedInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`\`${field}\` must be a non-negative integer`)
  }
  return value
}

/** 字符串数组；缺省当空数组（Rust 的 `#[serde(default)] args: Vec<String>`）。 */
export function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid(`\`${field}\` must be an array of strings`)
  return value.map((item, index) => requireString(item, `${field}[${index}]`))
}

/**
 * `Record<string, string>`；缺省当空表（Rust 的 `#[serde(default)] env: HashMap<String, String>`）。
 *
 * 只取**自有**键：载荷里的 `__proto__` 在 `JSON.parse` 之后是一个普通自有属性，用
 * `for...in` 会连原型链上的东西一起收进来。
 */
export function optionalStringRecord(
  value: unknown,
  field: string,
): Record<string, string> {
  if (value === undefined || value === null) return {}
  const record = requireRecord(value, field)
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, item] of Object.entries(record)) {
    result[key] = requireString(item, `${field}.${key}`)
  }
  return { ...result }
}

/** 任意 JSON 对象，内容不解释（`arguments` / `meta`）。 */
export function optionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return requireRecord(value, field)
}
