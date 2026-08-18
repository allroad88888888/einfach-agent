// `write_workspace_file` 的入参收窄与 handler 工厂
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_write.rs 的命令体（serde 那一层 + `journal_dir` 的解析）。
//
// 【大小写：一个对象里两种规则】
// 这条命令**带** `rename_all = "snake_case"`，所以顶层键是 `expected_old_content` /
// `create_dirs` / `exclusive_path_lock` / `dry_run` / `change_context`……**但 `change_context` 的
// 值内部是 camelCase**（`changeId` / `sessionId` / `runId` / `toolCallId`），因为那是它自己的
// struct 上的 serde 属性说了算，与命令的 rename_all 无关。全表最容易踩的一处，实证见
// `packages/agent-core/src/runtime/workspaceWrite.ts:102`。
//
// 【判缺席只看值，不用 `'key' in args`】
// core 的 `toTauriInput` 整份对象字面量返回，可选项无值时**键存在且为 undefined**；走 HTTP 时
// `JSON.stringify` 又会把这些键丢掉。同一份入参在进程内注入与 HTTP 两种传输下键集合不同，
// 用 `in` 会写出「本地能跑、上 server 就变」的 bug。
//
// 【类型不对是 rejection，不是 `ok: false` 的回执】
// Rust 侧这种情况在 serde 反序列化时就失败了，调用方拿到的是一次 invoke 失败而不是一份写入
// 回执——这里照此办理（抛错）。与之相对，「路径为空」「模式拼错」这类**值**的问题走结构化
// 回执，因为那是模型该看见并改正的东西。文案用中文：serde 的消息没有对应物，编不出来。

import { defaultJournalDirectory } from '../change/journalDirectory'
import { writeWorkspaceFile } from './pipeline'
import type { WriteWorkspaceFileRequest } from './pipeline'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'
import type { WorkspaceChangeContext } from '../change/types'

export function narrowWriteWorkspaceFileArgs(
  args: Record<string, unknown>,
): WriteWorkspaceFileRequest {
  return {
    path: requiredString(args.path, 'path'),
    content: requiredString(args.content, 'content'),
    mode: optionalString(args.mode, 'mode'),
    expectedOldContent: optionalString(args.expected_old_content, 'expected_old_content'),
    expectedContentHash: optionalString(args.expected_content_hash, 'expected_content_hash'),
    createDirs: optionalBoolean(args.create_dirs, 'create_dirs'),
    maxBytes: optionalNumber(args.max_bytes, 'max_bytes'),
    exclusivePathLock: optionalBoolean(args.exclusive_path_lock, 'exclusive_path_lock'),
    workspaceRoot: optionalString(args.workspace_root, 'workspace_root'),
    encoding: optionalString(args.encoding, 'encoding'),
    executable: optionalBoolean(args.executable, 'executable'),
    dryRun: optionalBoolean(args.dry_run, 'dry_run'),
    changeContext: optionalChangeContext(args.change_context),
    // `diagnostic_operation_id` 刻意不收：它在 Rust 侧只进分阶段耗时日志，不影响写入语义，
    // 而 Node 宿主还没有那条日志出口（见 pipeline 的报告）。收进来却不用，反而像是漏了什么。
  }
}

/**
 * 建 handler。日志目录在**工厂时**算一次并被闭包捕获——与 `revert_workspace_change` 同款：
 * 目录是「本机事实 + 装配槽」的函数，每次调用重算只会多一份漂移的机会。
 */
export function createWriteWorkspaceFileHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  const directory = defaultJournalDirectory(options)
  return async (args) => writeWorkspaceFile(narrowWriteWorkspaceFileArgs(args), directory)
}

/** 缺席：键不存在、值为 `undefined`、或值为 `null`（serde 的 `Option` 三者同义）。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`write_workspace_file 的 ${key} 必须是字符串`)
  return value
}

function optionalString(value: unknown, key: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new Error(`write_workspace_file 的 ${key} 必须是字符串`)
  return value
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'boolean') throw new Error(`write_workspace_file 的 ${key} 必须是布尔值`)
  return value
}

function optionalNumber(value: unknown, key: string): number | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`write_workspace_file 的 ${key} 必须是数字`)
  }
  return value
}

/** 四个字段全是必填字符串（Rust 的 `WorkspaceChangeContext` 没有一个 `Option`）。 */
function optionalChangeContext(value: unknown): WorkspaceChangeContext | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('write_workspace_file 的 change_context 必须是对象')
  }
  const record = value as Record<string, unknown>
  return {
    changeId: requiredString(record.changeId, 'change_context.changeId'),
    sessionId: requiredString(record.sessionId, 'change_context.sessionId'),
    runId: requiredString(record.runId, 'change_context.runId'),
    toolCallId: requiredString(record.toolCallId, 'change_context.toolCallId'),
  }
}
