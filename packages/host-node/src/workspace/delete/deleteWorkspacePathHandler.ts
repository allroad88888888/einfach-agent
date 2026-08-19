// `delete_workspace_path` 的入参收窄与 handler 工厂
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_delete.rs 的命令体（serde 那一层 + `journal_dir` 的解析）。
//
// 【大小写：一个对象里两种规则】
// 这条命令**带** `rename_all = "snake_case"`，所以顶层键是 `workspace_root` / `change_context`；
// **但 `change_context` 的值内部是 camelCase**（`changeId` / `sessionId` / `runId` /
// `toolCallId`），那是它自己 struct 上的 serde 属性说了算，与命令的 rename_all 无关。
// 实证见 `packages/agent-core/src/runtime/workspaceDelete.ts` 的 `toTauriInput` 那段。
//
// 【判缺席只看值，不用 `'key' in args`】
// core 的入参是整份对象字面量返回的，可选项无值时**键存在且为 undefined**；走 HTTP 时
// `JSON.stringify` 又会把这些键丢掉。同一份入参在进程内注入与 HTTP 两种传输下键集合不同，
// 用 `in` 会写出「本地能跑、上 server 就变」的 bug。
//
// 【类型不对是 rejection，不是 `ok: false` 的回执】
// Rust 侧这种情况在 serde 反序列化时就失败了，调用方拿到的是一次 invoke 失败而不是一份删除
// 回执——这里照此办理（抛错）。与之相对，「路径为空」「目标是软链」这类**值**的问题走结构化
// 回执，因为那是模型该看见并改正的东西。文案用中文：serde 的消息没有对应物，编不出来。

import { defaultJournalDirectory } from '../change/journalDirectory'
import { deleteWorkspacePath } from './pipeline'
import type { DeleteWorkspacePathRequest } from './pipeline'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'
import type { WorkspaceChangeContext } from '../change/types'

export function narrowDeleteWorkspacePathArgs(
  args: Record<string, unknown>,
): DeleteWorkspacePathRequest {
  return {
    path: requiredString(args.path, 'path'),
    recursive: optionalBoolean(args.recursive, 'recursive'),
    workspaceRoot: optionalString(args.workspace_root, 'workspace_root'),
    changeContext: optionalChangeContext(args.change_context),
  }
}

/**
 * 建 handler。日志目录在**工厂时**算一次并被闭包捕获——与 `write_workspace_file` /
 * `revert_workspace_change` 同款：目录是「本机事实 + 装配槽」的函数，每次调用重算只会多一份
 * 漂移的机会。
 */
export function createDeleteWorkspacePathHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  const directory = defaultJournalDirectory(options)
  return async (args) => deleteWorkspacePath(narrowDeleteWorkspacePathArgs(args), directory)
}

/** 缺席：键不存在、值为 `undefined`、或值为 `null`（serde 的 `Option` 三者同义）。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`delete_workspace_path 的 ${key} 必须是字符串`)
  return value
}

function optionalString(value: unknown, key: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new Error(`delete_workspace_path 的 ${key} 必须是字符串`)
  return value
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'boolean') throw new Error(`delete_workspace_path 的 ${key} 必须是布尔值`)
  return value
}

/** 四个字段全是必填字符串（Rust 的 `WorkspaceChangeContext` 没有一个 `Option`）。 */
function optionalChangeContext(value: unknown): WorkspaceChangeContext | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('delete_workspace_path 的 change_context 必须是对象')
  }
  const record = value as Record<string, unknown>
  return {
    changeId: requiredString(record.changeId, 'change_context.changeId'),
    sessionId: requiredString(record.sessionId, 'change_context.sessionId'),
    runId: requiredString(record.runId, 'change_context.runId'),
    toolCallId: requiredString(record.toolCallId, 'change_context.toolCallId'),
  }
}
