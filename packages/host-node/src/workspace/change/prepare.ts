// 变更集的登记生命周期：预留 → 标记已应用 / 丢弃
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_prepare.rs（已随 T1 删除）。
//
// 三段式，顺序是本域全部安全性的来源：
//
//   1. `prepare*`  —— **动手之前**把「原来长什么样」写进日志，状态 `prepared`。
//   2. 调用方执行那次不可逆动作（写文件 / 删除 / 复制 / 移动）。
//   3. 成功 → `markChangeApplied`；失败或 dry-run → `discardPreparedChange`。
//
// 顺序反过来（先动手再记账）在崩溃窗口里就是「改动已发生、日志没有」，那次改动永久撤不回来。
// 反之若登记成功而动作失败，留下的是一条状态停在 `prepared` 的孤儿账——第 3 步的 discard 正是
// 为它准备的，漏掉只是多一份垃圾，不会误撤。**宁可多一条账，不可少一条账。**
//
// 每个入口都先 `validateChangeId`，包括只拼路径不碰盘的 `changePayloadPath`——见 entryPaths.ts。

import { rm } from 'node:fs/promises'
import { pathExists } from '../common/pathExists'
import { buildChangeSet } from './buildChangeSet'
import { entryPath, payloadPath, validateChangeId } from './entryPaths'
import { updateStatus, writeEntry } from './entryStore'
import type { ChangeSetDraft } from './buildChangeSet'
import type {
  ChangeFileInput,
  RelocatedPath,
  TrackedPath,
  WorkspaceChangeContext,
  WorkspaceChangeSummary,
} from './types'

/** 整文件改写的登记（write 与 patch 用）。`files` 为空即拒——空账等于没账。 */
export async function prepareChangeSet(
  directory: string,
  context: WorkspaceChangeContext,
  workspaceRoot: string,
  files: readonly ChangeFileInput[],
): Promise<WorkspaceChangeSummary> {
  validateChangeId(context.changeId)
  if (files.length === 0) throw new Error('cannot journal an empty workspace change')
  await rejectExistingEntry(directory, context.changeId)
  return register(directory, { context, workspaceRoot, createdAt: epochNanoseconds(), files })
}

/**
 * 可恢复删除的登记（delete 用）。
 *
 * 比其它入口多查一次载荷路径：被删掉的内容会整份挪进 `<changeId>.payload`，那里若已经有东西，
 * 说明这个 id 被复用了——继续下去会用新的删除内容覆盖上一次的载荷，把上一次的删除变成不可恢复。
 */
export async function prepareDeletedPathChange(
  directory: string,
  context: WorkspaceChangeContext,
  workspaceRoot: string,
  path: string,
): Promise<WorkspaceChangeSummary> {
  validateChangeId(context.changeId)
  if (
    (await pathExists(entryPath(directory, context.changeId))) ||
    (await pathExists(payloadPath(directory, context.changeId)))
  ) {
    throw new Error('workspace change id already exists')
  }
  return register(directory, {
    context,
    workspaceRoot,
    createdAt: epochNanoseconds(),
    movedPaths: [{ path }],
  })
}

/** 复制出一条新路径的登记（copy 用）。 */
export async function prepareCreatedPathChange(
  directory: string,
  context: WorkspaceChangeContext,
  workspaceRoot: string,
  path: string,
  fingerprint: string,
): Promise<WorkspaceChangeSummary> {
  return preparePathOperationChange(directory, context, workspaceRoot, [{ path, fingerprint }], [])
}

/** 移动一条路径的登记（move 用）。`fingerprint` 描述的是移动**之后**的 destination。 */
export async function prepareRelocatedPathChange(
  directory: string,
  context: WorkspaceChangeContext,
  workspaceRoot: string,
  source: string,
  destination: string,
  fingerprint: string,
): Promise<WorkspaceChangeSummary> {
  return preparePathOperationChange(
    directory,
    context,
    workspaceRoot,
    [],
    [{ source, destination, fingerprint }],
  )
}

/**
 * 可恢复删除的载荷路径：调用方把要删的内容先整份复制到这里，再执行真删除。
 *
 * 不碰磁盘，只拼路径——所以它自己得做 id 校验，不能指望「后面还会校验」。
 */
export function changePayloadPath(directory: string, changeId: string): string {
  validateChangeId(changeId)
  return payloadPath(directory, changeId)
}

/** 动作成功后把状态推到 `applied`。失败即抛，由调用方决定补偿。 */
export async function markChangeApplied(directory: string, changeId: string): Promise<void> {
  await updateStatus(directory, changeId, 'applied')
}

/**
 * 丢弃一条尚未生效的登记：条目与载荷一起删掉。
 *
 * **全程吞掉错误**（对齐 Rust 的 `let _ = ...`）：它只在「动作已经失败/取消」的路径上被调用，那时
 * 调用方要报告的是原始失败，清理不干净顶多留下一条孤儿账，让它变成第二个错误只会盖掉真正的病因。
 *
 * 载荷可能是文件也可能是整棵目录树（删掉的是目录时），所以用 recursive。
 */
export async function discardPreparedChange(directory: string, changeId: string): Promise<void> {
  await rm(entryPath(directory, changeId), { force: true }).catch(() => {})
  await rm(payloadPath(directory, changeId), { recursive: true, force: true }).catch(() => {})
}

async function preparePathOperationChange(
  directory: string,
  context: WorkspaceChangeContext,
  workspaceRoot: string,
  createdPaths: readonly TrackedPath[],
  relocatedPaths: readonly RelocatedPath[],
): Promise<WorkspaceChangeSummary> {
  validateChangeId(context.changeId)
  await rejectExistingEntry(directory, context.changeId)
  return register(directory, {
    context,
    workspaceRoot,
    createdAt: epochNanoseconds(),
    createdPaths,
    relocatedPaths,
  })
}

/** 组装 → 落盘 → 回执。`reversible` 恒为 true：登记成功本身就是「这次改动可撤销」的定义。 */
async function register(
  directory: string,
  draft: ChangeSetDraft,
): Promise<WorkspaceChangeSummary> {
  await writeEntry(directory, buildChangeSet(draft))
  return { id: draft.context.changeId, reversible: true }
}

async function rejectExistingEntry(directory: string, changeId: string): Promise<void> {
  if (await pathExists(entryPath(directory, changeId))) {
    throw new Error('workspace change id already exists')
  }
}

/**
 * 创建时刻，epoch 纳秒——对齐 Rust 的
 * `SystemTime::now().duration_since(UNIX_EPOCH).as_nanos()`。
 *
 * 用 `performance.timeOrigin + performance.now()` 而不是 `Date.now()`：批量回滚按 `createdAt`
 * 排序决定执行顺序（`workspace_change_journal_batch.rs:45`「Journal creation order is
 * authoritative」），毫秒精度会让同一毫秒内登记的两条账并列，顺序退化成调用方传入的顺序。
 * `performance.now()` 有微秒级分辨率，够把它们分开。
 *
 * 精度的实话：结果落在 1.7e18 量级，double 在那里的间距约 256 ns，所以低位不精确。这不构成问题
 * ——这个值只用来排序，从不参与相等判断，也不是任何东西的身份。留在这里（IO 一侧）读时钟，是为了
 * 让 buildChangeSet 保持纯函数，W16 的逐字节对拍才喂得进固定 fixture。
 */
function epochNanoseconds(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1e6)
}
