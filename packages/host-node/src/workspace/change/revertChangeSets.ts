// 多条账的批量回滚：整批预演 → 逆序执行 → 失败重放
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_batch.rs 的 `revert_change_sets_blocking`。
//
// ═══ 顺序：账本的创建顺序说了算 ═══
// Rust 那句注释（`_batch.rs:45`）是 `Journal creation order is authoritative`：调用方**确实**会
// 按执行顺序传 id，但一批 id 可能是从多个并行子 Agent 的结果里拼出来的，那种拼法按子 Agent 分组
// 而不是按时间。所以这里不信入参顺序，按 `createdAt` 升序重排，再逆序（新→旧）执行。
//
// **顺序错了不会报错，会静默写坏文件**：同一个文件被连续改过两次时，先退老的那条会把它写回
// `v1`，再退新的那条又把它写回 `v2`——最终停在 `v2`，而用户以为两条都撤销了。
//
// 排序必须是**稳定**的：`createdAt` 相同（纳秒同刻，理论上可能）时保留调用方给的相对顺序。
// `Array.prototype.sort` 自 ES2019 起规范要求稳定，与 Rust `sort_by_key` 的稳定语义一致。
// W14 把 `createdAt` 做成纳秒精度正是为了让这种并列几乎不会出现（毫秒精度会让同一毫秒内登记的
// 两条账并列，顺序就退化成入参顺序了）。
//
// ═══ 部分失败：全成或全不动 ═══
// 预检阶段发现任何冲突 → 整批拒绝，一条盘都不碰（`conflict`，逐条列出冲突）。
// 执行阶段第 k 条失败 → 把前面 k-1 条**逐条重新应用回去**（逆序），然后报
// `failed` + `batch rollback stopped at <id>: <原因>`。此时：
//   · `revertedChangeSetIds` 是**空的**——虽然中途真的退掉过几条，但它们已经被补回去了，
//     报告里说「退掉了」会让调用方以为那几条不用再管。
//   · `conflicts` 也是空的——批量失败给的是一句原因，不是逐条冲突表（那是预检阶段的形态）。
//   · 失败的那条**状态不变**（仍是 `applied`），被补回去的那几条状态也回到 `applied`。
//     换句话说：**失败的账不会被标记成已回滚**，整批都还能重试。
//
// 单条回滚的 `already_reverted` 在这里没有对应物：批量是**跳过**已回滚的账（不算错、也不列进
// 结果），只处理还没退的那些。全都已经退过时，返回的是一个 `restoredFiles` 为空的
// `batch_reverted`——语义上「这批要求的状态已经达成」，与单条的 `already_reverted` 是同一个意思。

import { realpath } from 'node:fs/promises'
import { errorText } from '../common/errorText'
import { batchOverlapMessage } from './batchOverlapGuard'
import { simulateBatchRevert } from './batchSimulation'
import { reapplyChangeSet } from './reapplyChangeSet'
import { readEntry } from './entryStore'
import { validateChangeId } from './entryPaths'
import { revertChangeSet } from './revertChangeSet'
import { conflictResult, errorResult, restoredFilePaths, successResult } from './revertResult'
import type { WorkspaceChangeSet, WorkspaceRevertResult } from './types'

export async function revertChangeSets(
  directory: string,
  changeIds: readonly string[],
  dryRun: boolean,
  workspaceRoot: string,
): Promise<WorkspaceRevertResult> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(workspaceRoot)
  } catch (error) {
    throw new Error(`failed to resolve workspace root: ${errorText(error)}`)
  }

  const entries: WorkspaceChangeSet[] = []
  const seen = new Set<string>()
  for (const id of changeIds) {
    validateChangeId(id)
    // 重复 id 是调用方算错了，不是「幂等地少退一次」——同一条账在批次里出现两次，第二次的
    // 预检会读到已经退过的现状，静默通过或静默冲突都不是调用方想要的。
    if (seen.has(id)) return errorResult('failed', `duplicate change set id: ${id}`)
    seen.add(id)
    const entry = await readEntry(directory, id)
    if (entry.workspaceRoot !== canonicalRoot) {
      // 逐字比对的跨宿主隐患见 revertChangeSet.ts 的文件头（本卡的判断：留给 T 线）。
      return errorResult('workspace_mismatch', `change set ${id} belongs to a different workspace`)
    }
    entries.push(entry)
  }

  entries.sort((left, right) => left.createdAt - right.createdAt)
  const pendingNewestFirst = entries.filter((entry) => entry.status !== 'reverted').reverse()

  const overlap = batchOverlapMessage(pendingNewestFirst)
  if (overlap !== null) return errorResult('conflict', overlap)

  const simulation = await simulateBatchRevert(directory, canonicalRoot, pendingNewestFirst)
  if (simulation.kind === 'missingPayload') {
    return errorResult(
      'missing_payload',
      `recoverable delete payload is missing for ${simulation.changeId}`,
    )
  }
  if (simulation.conflicts.length > 0) return conflictResult(simulation.conflicts)

  const restoredFiles = pendingNewestFirst.flatMap(restoredFilePaths)
  if (dryRun) return successResult('batch_ready', restoredFiles)

  return executeBatch(directory, canonicalRoot, pendingNewestFirst, restoredFiles)
}

async function executeBatch(
  directory: string,
  canonicalRoot: string,
  pendingNewestFirst: readonly WorkspaceChangeSet[],
  restoredFiles: string[],
): Promise<WorkspaceRevertResult> {
  const reverted: string[] = []
  for (const entry of pendingNewestFirst) {
    const result = await revertChangeSet(directory, entry.id, false, canonicalRoot)
    if (!result.ok) {
      for (const id of [...reverted].reverse()) {
        // 补偿失败吞掉：此时要报的是本次批量停在哪、为什么，第二个错误只会盖掉它。
        await reapplyChangeSet(directory, id, canonicalRoot).catch(() => {})
      }
      // `error` 为 null 的失败（预检冲突）只有 status 可说，照抄 Rust 的 `unwrap_or(status)`。
      const reason = result.error ?? result.status
      return errorResult('failed', `batch rollback stopped at ${entry.id}: ${reason}`)
    }
    reverted.push(entry.id)
  }
  return successResult('batch_reverted', restoredFiles, reverted)
}
