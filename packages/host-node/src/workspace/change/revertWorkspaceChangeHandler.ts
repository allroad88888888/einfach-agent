// `revert_workspace_change` 的入参收窄、单/批分派与 handler 工厂
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal.rs（已随 T1 删除）的 `revert_workspace_change` 命令体。
//
// 【大小写】这条命令**带** `rename_all = "snake_case"`，顶层键就是 `change_set_id` /
// `change_set_ids` / `dry_run` / `workspace_root`；core 的 `runtime/workspaceChange.ts` 已经按这个
// 形状发出来了，这里照收，不再转一次。
//
// 【判缺席只看值】不用 `'key' in args`：core 那边是整份对象字面量返回，可选项没有值时键存在且
// 为 `undefined`；走 HTTP 时 `JSON.stringify` 又会把它丢掉。同一份入参在两种传输下键集合不同。
//
// 【单条还是批量，由**有效 id 数量**决定，不由调用方用了哪个参数决定】
// Rust 的取法是：`change_set_ids` 非空则用它，否则退回 `change_set_id` 包成单元素数组，两个都
// 没有就报错；随后 `ids.len() == 1` 走单条、否则走批量。所以 `change_set_ids: ["a"]` 走的是
// **单条**路径——两条路径对同一条账的可观测差别在于 status（`reverted` vs `batch_reverted`）与
// 「已回滚」的表现（单条给 `already_reverted`，批量是跳过）。照搬，别自作主张统一。
//
// 【日志目录没有覆盖槽】`defaultJournalDirectory` 是唯一来源（W14 的裁决：加一个旋钮就等于多
// 一处「两个宿主可能不一致」）。所以工厂只负责把它绑上去，真正的实现 `revertWorkspaceChange`
// 把 directory 当第一个参数收——测试指哪写哪，不需要旋钮。

import { resolveWorkspaceRoot } from '../common/resolveWorkspaceRoot'
import { defaultJournalDirectory } from './journalDirectory'
import { revertChangeSet } from './revertChangeSet'
import { revertChangeSets } from './revertChangeSets'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'
import type { WorkspaceRevertResult } from './types'

/** 收窄后的入参。字段名转成 camelCase——从这里往下就是本包自己的内部形状了。 */
export interface RevertWorkspaceChangeRequest {
  changeSetId?: string
  changeSetIds?: string[]
  dryRun?: boolean
  workspaceRoot?: string
}

export function narrowRevertWorkspaceChangeArgs(
  args: Record<string, unknown>,
): RevertWorkspaceChangeRequest {
  return {
    changeSetId: optionalString(args.change_set_id, 'change_set_id'),
    changeSetIds: optionalStringArray(args.change_set_ids, 'change_set_ids'),
    dryRun: optionalBoolean(args.dry_run, 'dry_run'),
    workspaceRoot: optionalString(args.workspace_root, 'workspace_root'),
  }
}

export async function revertWorkspaceChange(
  directory: string,
  request: RevertWorkspaceChangeRequest,
): Promise<WorkspaceRevertResult> {
  // workspace root 先解析：Rust 侧同样在取 id 之前做，所以「根都不对」比「没给 id」先报出来。
  const root = await resolveWorkspaceRoot(request.workspaceRoot)
  const ids = changeSetIds(request)
  const dryRun = request.dryRun ?? false
  return ids.length === 1
    ? revertChangeSet(directory, ids[0], dryRun, root)
    : revertChangeSets(directory, ids, dryRun, root)
}

export function createRevertWorkspaceChangeHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  const directory = defaultJournalDirectory(options)
  return async (args) => revertWorkspaceChange(directory, narrowRevertWorkspaceChangeArgs(args))
}

/** 空数组等同没给（Rust 的 `.filter(|ids| !ids.is_empty())`），随后才轮到单个 id。 */
function changeSetIds(request: RevertWorkspaceChangeRequest): string[] {
  if (request.changeSetIds && request.changeSetIds.length > 0) return request.changeSetIds
  if (request.changeSetId !== undefined) return [request.changeSetId]
  throw new Error('change_set_id or change_set_ids is required')
}

/** 缺席：键不存在、值为 `undefined`、或值为 `null`（serde 的 `Option` 三者同义）。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function optionalString(value: unknown, key: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new Error(`revert_workspace_change 的 ${key} 必须是字符串`)
  return value
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'boolean') throw new Error(`revert_workspace_change 的 ${key} 必须是布尔值`)
  return value
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (isAbsent(value)) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`revert_workspace_change 的 ${key} 必须是字符串数组`)
  }
  return [...(value as string[])]
}
