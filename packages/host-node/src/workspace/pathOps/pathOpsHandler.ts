// `copy_workspace_path` / `move_workspace_path` 的入参收窄与 handler 工厂
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_path_ops.rs（已随 T1 删除）的两个命令体。两条命令的入参**完全一致**
// （`commandArgs.ts` 里 `move_workspace_path` 直接复用 `copy_workspace_path` 的类型），Rust 侧也是
// 同一个 `operate()` 函数收两个不同的 `operation` 字符串，所以这里同样只写一套收窄逻辑，
// 用 operation 参数化出两个 handler 工厂。
//
// 【大小写：一个对象里两种规则】命令**带** `rename_all = "snake_case"`，顶层键是
// `workspace_root` / `change_context`；但 `change_context` 的**值**内部是 camelCase
// （`changeId` / `sessionId` / `runId` / `toolCallId`），与命令自身的 rename_all 无关。
//
// 【判缺席只看值，不用 `'key' in args`】core 的 `toTauriInput` 整份对象字面量返回，可选项无值时
// **键存在且为 undefined**；走 HTTP 时 `JSON.stringify` 又会把这些键丢掉。
//
// 【类型不对是 rejection，不是 `ok: false` 的回执】Rust 侧这种情况在 serde 反序列化时就失败了，
// 调用方拿到的是一次 invoke 失败，不是一份操作回执——这里照此办理（抛错）。与之相对，"source 和
// destination 相同""目标已存在"这类**值**的问题走结构化回执（`pipeline.ts`），因为那是模型该看见
// 并改正的东西。

import { decodeWorkspaceChangeContext } from '../change/decodeWorkspaceChangeContext'
import { defaultJournalDirectory } from '../change/journalDirectory'
import { operateWorkspacePath } from './pipeline'
import type { WorkspacePathOperationRequest } from './pipeline'
import type { WorkspacePathOperationName } from './result'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

export function narrowWorkspacePathOperationArgs(
  operation: WorkspacePathOperationName,
  args: Record<string, unknown>,
): WorkspacePathOperationRequest {
  const command = commandName(operation)
  const request: WorkspacePathOperationRequest = {
    source: requiredString(command, args.source, 'source'),
    destination: requiredString(command, args.destination, 'destination'),
  }
  const workspaceRoot = optionalString(command, args.workspace_root, 'workspace_root')
  if (workspaceRoot !== undefined) request.workspaceRoot = workspaceRoot
  const changeContext = decodeWorkspaceChangeContext(command, args.change_context)
  if (changeContext !== undefined) request.changeContext = changeContext
  return request
}

/**
 * 建 handler。日志目录在**工厂时**算一次并被闭包捕获——与 write/patch 域同款：目录是「本机事实
 * + 装配槽」的函数，每次调用重算只会多一份漂移的机会。
 */
function createPathOperationHandler(
  operation: WorkspacePathOperationName,
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  const directory = defaultJournalDirectory(options)
  return async (args) =>
    operateWorkspacePath(operation, narrowWorkspacePathOperationArgs(operation, args), directory)
}

export function createCopyWorkspacePathHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return createPathOperationHandler('copy', options)
}

export function createMoveWorkspacePathHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return createPathOperationHandler('move', options)
}

function commandName(operation: WorkspacePathOperationName): string {
  return `${operation}_workspace_path`
}

/** 缺席：键不存在、值为 `undefined`、或值为 `null`（serde 的 `Option` 三者同义）。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function requiredString(command: string, value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`${command} 的 ${key} 必须是字符串`)
  return value
}

function optionalString(command: string, value: unknown, key: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new Error(`${command} 的 ${key} 必须是字符串`)
  return value
}
