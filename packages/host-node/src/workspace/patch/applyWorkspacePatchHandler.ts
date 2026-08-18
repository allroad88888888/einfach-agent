// `apply_workspace_patch` 的入参收窄与 handler 工厂
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch.rs 的命令体。Tauri 那边靠 serde 把参数反序列化成
// 强类型，这条路上没有那一层：路由表交给 handler 的是 `Record<string, unknown>`，而同一张表要挂在
// `POST /api/invoke/:command` 后面，载荷来自浏览器。
//
// 【大小写：顶层与嵌套两层不同款】这条命令**带** `rename_all = "snake_case"`，所以顶层键是
// `operations` / `dry_run` / `workspace_root` / `change_context` / `diagnostic_operation_id`；而
// `change_context` 的**值**是 camelCase（`changeId` / `sessionId` / `runId` / `toolCallId`），
// `operations[]` 更混——判别键 `type` 的取值是 snake_case，字段却是 camelCase。收窄逐层照办。
//
// 【收窄失败 = 整条命令失败，不是某条操作被拒】与 W12 的 `parsePatchOperations` 同一个理由：
// `rejected[]` 的语义是「这条操作的语义不成立」（文件不存在、守卫不匹配），把「你传的 JSON 不对」
// 混进去会让模型以为改改内容重试就行。
//
// 【判缺席只看值】不用 `'key' in args`：core 的 `toTauriInput` 整份对象字面量返回，可选项没有值时
// **键存在且为 `undefined`**，走 HTTP 时 `JSON.stringify` 又会把它丢掉。用 `in` 会写出「进程内能跑、
// 上 server 就变」的 bug。
//
// 【日志目录没有覆盖槽】`defaultJournalDirectory` 是唯一来源（W14 的裁决），工厂只负责把它绑上去；
// 真正的实现 `applyPatch` 把 directory 当参数收，测试指哪写哪。**只有带 `change_context` 时才用它**
// ——不带就是一次不可回滚的直接写，与桌面端一致。

import { applyPatch } from './pipeline'
import { defaultJournalDirectory } from '../change/journalDirectory'
import { parsePatchOperations } from './operation'
import type { NodeHostCommandHandler } from '../../routeTable'
import type { PatchJournalTarget } from './pipeline'
import type { WorkspaceChangeContext } from '../change/types'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { PatchOperation } from './types'
import type { WorkspacePatchResult } from './result'

/** 收窄后的入参。从这里往下就是本包自己的内部形状（camelCase）了。 */
export interface ApplyWorkspacePatchRequest {
  operations: PatchOperation[]
  dryRun: boolean
  workspaceRoot?: string
  changeContext?: WorkspaceChangeContext
}

export function narrowApplyWorkspacePatchArgs(
  args: Record<string, unknown>,
): ApplyWorkspacePatchRequest {
  const request: ApplyWorkspacePatchRequest = {
    operations: parsePatchOperations(args.operations),
    dryRun: optionalBoolean(args.dry_run, 'dry_run') ?? false,
  }
  const workspaceRoot = optionalString(args.workspace_root, 'workspace_root')
  if (workspaceRoot !== undefined) request.workspaceRoot = workspaceRoot
  const changeContext = optionalChangeContext(args.change_context)
  if (changeContext !== undefined) request.changeContext = changeContext
  // `diagnostic_operation_id` 只喂 Rust 侧的 perf 日志，Node 宿主还没有那个出口（见 pipeline.ts）。
  // 收下不校验：为一个不影响任何行为的字段拒掉整条命令，代价与收益完全不成比例。
  return request
}

export function createApplyWorkspacePatchHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  const directory = defaultJournalDirectory(options)
  return async (args) => applyWorkspacePatch(directory, narrowApplyWorkspacePatchArgs(args))
}

export async function applyWorkspacePatch(
  journalDirectory: string,
  request: ApplyWorkspacePatchRequest,
): Promise<WorkspacePatchResult> {
  const journal: PatchJournalTarget | undefined = request.changeContext
    ? { directory: journalDirectory, context: request.changeContext }
    : undefined
  return applyPatch({
    operations: request.operations,
    dryRun: request.dryRun,
    ...(request.workspaceRoot === undefined ? {} : { workspaceRoot: request.workspaceRoot }),
    ...(journal === undefined ? {} : { journal }),
  })
}

/** 缺席：键不存在、值为 `undefined`、或值为 `null`（serde 的 `Option` 三者同义）。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function optionalString(value: unknown, key: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new Error(`apply_workspace_patch 的 ${key} 必须是字符串`)
  return value
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'boolean') throw new Error(`apply_workspace_patch 的 ${key} 必须是布尔值`)
  return value
}

/**
 * `change_context` 的四个字段**全都必填**（Rust 侧是无 `Option` 的 struct，缺一个 serde 直接拒）。
 * 缺一个就记不成一条完整的账，而那条账是「这次改动可撤销」的唯一凭据。
 */
function optionalChangeContext(value: unknown): WorkspaceChangeContext | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('apply_workspace_patch 的 change_context 必须是对象')
  }
  const raw = value as Record<string, unknown>
  return {
    changeId: requiredContextField(raw, 'changeId'),
    sessionId: requiredContextField(raw, 'sessionId'),
    runId: requiredContextField(raw, 'runId'),
    toolCallId: requiredContextField(raw, 'toolCallId'),
  }
}

function requiredContextField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string') {
    throw new Error(`apply_workspace_patch 的 change_context.${key} 必须是字符串`)
  }
  return value
}
