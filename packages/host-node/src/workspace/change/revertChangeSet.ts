// 单条账的回滚：先判能不能回，再决定是预演还是真回
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_revert.rs 的 `revert_change_set_blocking`
// （顶层编排那半；预检在 revertPlan.ts，执行与补偿在 revertExecute.ts）。
//
// 关卡顺序是有讲究的，**每一关都在「碰盘」之前**：
//   1. change id 合法性 —— id 会被拼进文件路径。
//   2. 已经回滚过 → `already_reverted`（`ok: true`）。**幂等**：重复请求不是错误，UI 上「撤销」
//      被点两次、或崩溃恢复后重放一次都会走到这里。注意这一关在 workspace 比对**之前**，
//      与 Rust 一致——已回滚的账不该因为换了个 workspace 就报错。
//   3. workspace 是不是同一个 —— 见下面那段大字。
//   4. 预检（解析路径 + 收集冲突）。
//   5. 可恢复删除的载荷还在不在。
//   6. 有冲突 → `conflict`，一条盘都不碰。
//   7. `dryRun` → `ready`，同样一条盘都不碰。
//
// ═══ `dryRun` 做到哪一步：预演，不是「只校验」 ═══
// 它跑完上面 1–6 的**全部**检查（含冲突检测、路径解析、载荷存在性），只在最后一步分岔：不执行、
// 不改条目状态，返回 `status: 'ready'` 且 `revertedChangeSetIds` 为空。**`restoredFiles` 与真跑
// 逐字相同**（同一个 `restoredFilePaths`），所以「预演说会还原这些」就是真跑会还原的那些。
// 它唯一测不到的是执行期才会出现的失败（写盘失败、执行前重查发现的新漂移）——那类失败真跑时
// 会被完整补偿，不会留下半个回滚。
//
// ═══ ⚠️ workspaceRoot 逐字比对：Windows 上的跨宿主隐患，本卡的判断是「不在这里修」 ═══
// 条目里存的 `workspaceRoot` 是登记时 canonicalize 出来的绝对路径，这里拿本次的 canonical root
// 逐字比。Rust 的 `fs::canonicalize` 在 Windows 上给 verbatim 前缀（`\\?\C:\ws`），Node 的
// `realpath` 给 `C:\ws`——同一个目录两种写法，套壳后互相不认，整批回滚全部 `workspace_mismatch`。
//
// 本卡**不加归一化**，三条理由：
//   1. **单边归一化只修一半**。Node 认了 Rust 写的账，Rust 侧仍不认 Node 写的账（它那边还是
//      逐字比 `\\?\C:\ws`）。修一半比不修更危险：症状从「全都撤不了」变成「有时撤得了」。
//   2. **病根在写入侧，不在比较侧**。两个宿主对「canonical 是什么」定义不同，正确的修法是让
//      两边写进日志的形态统一（去掉 verbatim 前缀），那要同时改 Rust 的 prepare 与 revert。
//      在比较处打补丁是把不一致藏起来，日志里存的仍是两种字符串。
//   3. 现状下 Node 自洽（自己写自己读），POSIX 上两边一致。风险窗口只在「Rust 写、Node 读」的
//      过渡期，而那个过渡期正是 T 线套壳本身。
// 归属：**T 线（Tauri 退成套壳）开工前必须解决**，与 docs/node-host-issues.md 的「跨宿主隐患」
// 一节同一条。本卡把判断写在这里，不是忘了。

import { realpath } from 'node:fs/promises'
import { errorText } from '../common/errorText'
import { payloadPath, validateChangeId } from './entryPaths'
import { readEntry } from './entryStore'
import { executeRevert } from './revertExecute'
import { planRevert } from './revertPlan'
import { symlinkExists } from './pathProbe'
import { conflictResult, errorResult, restoredFilePaths, successResult } from './revertResult'
import type { WorkspaceRevertResult } from './types'

export async function revertChangeSet(
  directory: string,
  changeId: string,
  dryRun: boolean,
  workspaceRoot: string,
): Promise<WorkspaceRevertResult> {
  validateChangeId(changeId)
  const entry = await readEntry(directory, changeId)
  if (entry.status === 'reverted') {
    return successResult('already_reverted', [])
  }

  const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot)
  if (entry.workspaceRoot !== canonicalRoot) {
    return errorResult('workspace_mismatch', 'change set belongs to a different workspace')
  }

  const plan = await planRevert(canonicalRoot, entry)
  // 载荷丢了就没有内容可还原——这比冲突更硬，所以**先于**冲突返回（与 Rust 的顺序一致）。
  if (entry.movedPaths.length > 0 && !(await symlinkExists(payloadPath(directory, changeId)))) {
    return errorResult('missing_payload', 'recoverable delete payload is missing')
  }
  if (plan.conflicts.length > 0) {
    return conflictResult(plan.conflicts)
  }
  if (dryRun) {
    return successResult('ready', restoredFilePaths(entry))
  }
  return executeRevert(directory, canonicalRoot, entry, plan)
}

/**
 * 等价 Rust 的 `fs::canonicalize(workspace_root)`，文案照抄。
 *
 * 与 common 的 `resolveWorkspaceRoot` 不是一回事：那个负责「该用哪个根」（含 git 兜底与拒绝
 * 文件系统根），这里只负责把已经定下来的根解成 canonical 形态，好和条目里存的那份比。
 */
async function canonicalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot)
  } catch (error) {
    throw new Error(`failed to resolve workspace root: ${errorText(error)}`)
  }
}
