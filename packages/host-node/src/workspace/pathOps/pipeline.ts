// copy / move 主流程：解析 → 记账 → 落盘 → 收尾
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_path_ops.rs（已随 T1 删除）的 `operate()`。Rust 侧用一个字符串参数
// `operation: &str`（"copy" | "move"）在同一个函数体里分叉两条命令；Node 侧同样用一个联合类型
// 参数保留这个共享结构——**这不是重新设计**，两条命令的入参、confinement、记账时机、失败收尾
// 完全一致，只有"具体动哪个 fs 原语"这一处不同。
//
// ═══ 顺序（每一步都在 Rust 源里能对上号，别按直觉重排）═══
//  1. 解析 workspace root。
//  2. 解析 source——**必须已存在**（读取形态：canonicalize 之后比边界）。
//  3. 解析 destination——**必须尚不存在**（写入形态的变体：目标不许已经有东西）。
//  4. source === destination 直接拒（两条命令的目的地/源永远该是两个不同的地方）。
//  5. 没有 `change_context` 直接拒——copy/move 不支持"不记账的直接操作"，这与 write/patch 不同
//     （那两个允许不带 change_context 的不可回滚直写），因为 Rust 侧 `operate()` 把这一检查放在
//     固定位置、无条件要求，照搬。
//  6. 对 **source** 算指纹——回滚前重算一次，指纹对不上就说明这条路径被后续动作改过。
//  7. 算根相对展示路径，Git 元数据守卫（`.git` 或 `.git/` 前缀，源或目标任一命中即拒）。
//  8. **登记变更集**（copy → `createdPaths`，move → `relocatedPaths`）——必须先记账再动手，
//     顺序反过来在崩溃窗口里就是"改动已发生、日志没有"，见 change/prepare.ts 文件头。
//  9. 真正执行 `copyPath` / `movePath`；失败就丢弃刚才登记的账（此时磁盘还没变化或已被
//     copyPath/movePath 自己回滚到位，账不该留下）。
//  10. `markChangeApplied`；失败要把已经落地的动作**撤回**（copy 删掉目标、move 移回源），
//      再丢弃账——这个分支在 Rust 侧同样存在，测不到不代表不用写。

import { lstat, rm } from 'node:fs/promises'
import { errorText, resolveWorkspaceRoot } from '../common'
import {
  discardPreparedChange,
  markChangeApplied,
  prepareCreatedPathChange,
  prepareRelocatedPathChange,
} from '../change/prepare'
import { copyPath } from '../change/pathOpsCopy'
import { movePath } from '../change/pathOpsMove'
import { pathFingerprint } from '../change/pathOpsFingerprint'
import { failedResult } from './result'
import { relativeDisplay, resolveDestination, resolveSource } from './resolveTarget'
import type { WorkspaceChangeContext, WorkspaceChangeSummary } from '../change/types'
import type { WorkspacePathOperationName, WorkspacePathOperationResult } from './result'

export interface WorkspacePathOperationRequest {
  source: string
  destination: string
  workspaceRoot?: string
  changeContext?: WorkspaceChangeContext
}

export async function operateWorkspacePath(
  operation: WorkspacePathOperationName,
  request: WorkspacePathOperationRequest,
  journalDirectory: string,
): Promise<WorkspacePathOperationResult> {
  const fail = (error: string): WorkspacePathOperationResult =>
    failedResult(operation, request.source, request.destination, error)

  let root: string
  try {
    root = await resolveWorkspaceRoot(request.workspaceRoot)
  } catch (error) {
    return fail(errorText(error))
  }

  let source: string
  try {
    source = await resolveSource(root, request.source)
  } catch (error) {
    return fail(errorText(error))
  }

  let destination: string
  try {
    destination = await resolveDestination(root, request.destination)
  } catch (error) {
    return fail(errorText(error))
  }

  if (source === destination) return fail('source and destination must differ')

  const context = request.changeContext
  if (!context) return fail('path operation requires runtime change context')

  let fingerprint: string
  try {
    fingerprint = await pathFingerprint(source)
  } catch (error) {
    return fail(errorText(error))
  }

  const sourceRelative = relativeDisplay(root, source)
  const destinationRelative = relativeDisplay(root, destination)
  if (isGitMetadata(sourceRelative) || isGitMetadata(destinationRelative)) {
    return fail('path operations refuse Git metadata')
  }

  const changeId = context.changeId
  let changeSet: WorkspaceChangeSummary
  try {
    changeSet =
      operation === 'copy'
        ? await prepareCreatedPathChange(journalDirectory, context, root, destinationRelative, fingerprint)
        : await prepareRelocatedPathChange(
            journalDirectory,
            context,
            root,
            sourceRelative,
            destinationRelative,
            fingerprint,
          )
  } catch (error) {
    return fail(errorText(error))
  }

  try {
    await (operation === 'copy' ? copyPath(source, destination) : movePath(source, destination))
  } catch (error) {
    await discardPreparedChange(journalDirectory, changeId)
    return fail(errorText(error))
  }

  try {
    await markChangeApplied(journalDirectory, changeId)
  } catch (error) {
    await rollbackAppliedOperation(operation, source, destination)
    await discardPreparedChange(journalDirectory, changeId)
    return fail(errorText(error))
  }

  return {
    ok: true,
    source: sourceRelative,
    destination: destinationRelative,
    operation,
    reversible: true,
    error: null,
    changeSet,
  }
}

function isGitMetadata(relativePath: string): boolean {
  return relativePath === '.git' || relativePath.startsWith('.git/')
}

/**
 * `markChangeApplied` 失败时把已经落地的动作撤回：copy 删掉刚复制出来的目标，move 移回源。
 * **全程吞掉错误**（对齐 Rust 的 `let _ = ...`）：此时要报给调用方的是 markChangeApplied 的原始
 * 失败，撤回本身再失败只会盖掉真正的病因，顶多留下一份没清理干净的磁盘状态。
 */
async function rollbackAppliedOperation(
  operation: WorkspacePathOperationName,
  source: string,
  destination: string,
): Promise<void> {
  try {
    if (operation === 'copy') {
      await removePath(destination)
    } else {
      await movePath(destination, source)
    }
  } catch {
    // 见上方注释：吞掉。
  }
}

/** 等价 Rust 本地的 `remove_path`：目录整棵删，文件单个删。仅用于上面吞错误的回滚路径。 */
async function removePath(path: string): Promise<void> {
  const stats = await lstat(path)
  if (stats.isDirectory()) {
    await rm(path, { recursive: true })
  } else {
    await rm(path)
  }
}
