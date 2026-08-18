// `run_shell_command` 的命令入口：收窄线上入参，交给 pipeline
// ---------------------------------------------------------------------------
// 对应 Rust 的 `#[tauri::command(rename_all = "snake_case")] run_shell_command`
// （apps/desktop/src/shell.rs）。那边「入参长这样」是由 serde 反序列化保证的，Node 这条路上
// 没有那一层：同一张路由表要挂在 `POST /api/invoke/:command` 后面，载荷是外部输入。
// 所以本文件做的就是 serde 那件事——**类型不对就当场失败，而不是带着 undefined 往下走**。
//
// 【键名】顶层是 snake_case（`timeout_ms` / `max_output_chars`），因为这条命令带
// `rename_all = "snake_case"`，core 的 `toTauriInput`（runtime/shellCommand.ts）已经转好了。
// 这里**不要**再认一遍驼峰：多认一种写法等于多一条没人测的路径，而真正的调用方只有一个。
//
// 【判存在只看值，不用 `'key' in args`】core 的 `toTauriInput` 是整份对象字面量返回，
// 可选项没有值时键**存在且为 undefined**；进程内注入时它原样到达，走 HTTP 时
// `JSON.stringify` 又会把它丢掉。用 `in` 会写出「本地能跑、上 server 就变」的 bug。
//
// 【失败文案的语言】这一层的失败在 Rust 侧没有对应物（那边由 serde 挡住，报的是框架文案），
// 所以按仓库约定用中文；进了 pipeline 之后的失败文案一律保持英文原文，与桌面端逐字一致。

import { executeShellCommand, type ShellCommandRequest } from './pipeline'
import type { NodeHostCommandHandler } from '../routeTable'

export function createRunShellCommandHandler(): NodeHostCommandHandler {
  return async (args) => executeShellCommand(narrowShellCommandArgs(args))
}

/** 把一袋 unknown 收窄成一次请求。任何一项类型不对都就地失败。 */
export function narrowShellCommandArgs(args: Record<string, unknown>): ShellCommandRequest {
  return {
    platform: requiredString(args, 'platform'),
    command: requiredString(args, 'command'),
    cwd: optionalString(args, 'cwd'),
    timeoutMs: optionalNumber(args, 'timeout_ms'),
    maxOutputChars: optionalNumber(args, 'max_output_chars'),
    env: optionalStringMap(args, 'env'),
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (value === undefined) throw new Error(`run_shell_command 缺少 ${key} 参数`)
  if (typeof value !== 'string') {
    throw new Error(`run_shell_command 的 ${key} 参数必须是字符串，实际收到 ${typeName(value)}`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`run_shell_command 的 ${key} 参数必须是字符串，实际收到 ${typeName(value)}`)
  }
  return value
}

/**
 * 可选数值。**非有限数（NaN / Infinity）也在这里拦**：Rust 侧的 `Option<u64>` 根本收不到
 * 它们，而放行的话 `setTimeout(NaN)` 会当成 0 立刻超时——一次「参数写错」变成一次
 * 「命令莫名其妙被杀」。至于超界与零，pipeline 的 normalize 按 Rust 的规则回落到默认值。
 */
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`run_shell_command 的 ${key} 参数必须是有限数字，实际收到 ${typeName(value)}`)
  }
  return value
}

/** 可选的环境变量表。对齐 `Option<HashMap<String, String>>`：值必须全是字符串。 */
function optionalStringMap(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`run_shell_command 的 ${key} 参数必须是字符串字典，实际收到 ${typeName(value)}`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [name, item] of entries) {
    if (typeof item !== 'string') {
      throw new Error(`run_shell_command 的 ${key}.${name} 必须是字符串，实际收到 ${typeName(item)}`)
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}
