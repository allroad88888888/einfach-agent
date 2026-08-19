// 写入主流水线：校验 → 解析 → 建父目录 → 取锁 → 临界区 → 收尾
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_pipeline.rs 的
// `write_workspace_file_blocking_with_journal`。本文件只负责**锁外**的那一半；锁里的
// 「读—验—记账—落盘」在 pipelineWrite.ts。
//
// ═══ 顺序（每一步的位置都有理由，别按直觉重排）═══
//  1. 解析模式与编码 —— 纯字符串判定，最便宜的拒绝放最前。
//  2. 守卫的组合合法性 —— `create` + 守卫互斥（create 要求文件不存在，守卫要求它存在且是某个
//     样子）；两种守卫不能同时给。
//  3. **把 content 解成完整字节，再比上限** —— W5 点名要保住这个顺序：既不按调用方声明的大小
//     拒，也不边写边数。代价是整份内容先进内存（这正是硬上限只有 8 MiB 的原因），换来的是
//     「超限时磁盘上什么都不会留下」。
//  4. 解析 workspace root 与目标路径 —— **排在限额之后**，所以超限失败的回执里 `path` 字段是
//     调用方**原样传入**的那个串，而不是根相对展示路径。这是可观测差异，测试钉着。
//  5. 建父目录（`createDirs` 默认 **true**，与 apply_patch 一致：缺父目录曾是首次写入最常见的
//     失败）。
//  6. 跨进程归档锁（仅 `exclusivePathLock`）→ 归档 compaction（仅 append + 该锁）。
//  7. 进程内写锁 → 临界区。
//
// ═══ 锁的释放 ═══
// Rust 靠两个 guard 的 Drop，作用域一到自动释放；JS 没有 Drop，所以：
//   · 进程内锁交给 W6 的 `withPathLock(key, operation)` —— 释放由锁表自己做，调用方漏不掉，
//     这正是它没有照搬 Rust「返回一把锁自己 lock」的原因。
//   · 跨进程归档锁必须由本文件在 `finally` 里 `release()`（W6 明写这是调用方的责任）。
//     它包在临界区**外面**：抛异常、按设计拒绝、正常返回三条路径都会经过那个 finally。
//     漏掉的后果不是本进程死锁，而是磁盘上留一个锁文件，别的进程要等 30 秒陈旧超时才敢接管。

import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errorText, resolveWorkspaceRoot } from '../common'
import { maybeCompactSubagentIndex } from './compaction'
import { acquireArchivePathLock } from './lockArchive'
import { contentTooLargeMessage, normalizeMaxBytes } from './limitChecks'
import { withPathLock } from './lockTable'
import { parseEncoding, parseMode } from './options'
import { buildPayload } from './pipelinePayload'
import { runWriteCriticalSection } from './pipelineWrite'
import { errorResult, rejectWrite, WriteRejection } from './result'
import { resolveWriteTarget } from './targetPath'
import type { ArchivePathLock } from './lockArchive'
import type { WorkspaceChangeContext } from '../change/types'
import type { WorkspaceWriteResult } from './result'
import type { ResolvedWriteTarget } from './types'

/** 收窄之后的入参（字段名转成 camelCase；线上的 snake_case 只活到 handler 那一层）。 */
export interface WriteWorkspaceFileRequest {
  path: string
  content: string
  mode?: string
  expectedOldContent?: string
  expectedContentHash?: string
  createDirs?: boolean
  maxBytes?: number
  exclusivePathLock?: boolean
  workspaceRoot?: string
  encoding?: string
  executable?: boolean
  dryRun?: boolean
  changeContext?: WorkspaceChangeContext
}

/**
 * 跑一次 `write_workspace_file`。
 *
 * `journalDirectory` 是变更日志目录（`defaultJournalDirectory(options)`）；只有请求里带了
 * `changeContext` 才真的记账——不带就是一次明确的、不可回滚的直接写。
 *
 * **按设计的拒绝一律是 `ok: false` 的回执，不是 rejection**：模型要能读到那句话并照着改。
 * 非 `WriteRejection` 的异常原样上抛（那是宿主自己的 bug，该响亮地失败）。
 */
export async function writeWorkspaceFile(
  request: WriteWorkspaceFileRequest,
  journalDirectory: string,
): Promise<WorkspaceWriteResult> {
  // 路径解析成功之前，回执里的 path 就是调用方原样传入的串（见上面第 4 条）。
  let reportedPath = request.path
  try {
    const mode = parseMode(request.mode)
    const encoding = parseEncoding(request.encoding)
    if (mode === 'create' && hasGuard(request)) {
      rejectWrite('optimistic guards are not valid with mode "create"; the file must not exist')
    }
    if (request.expectedOldContent !== undefined && request.expectedContentHash !== undefined) {
      rejectWrite('pass either expectedOldContent or expectedContentHash, not both')
    }

    const payload = buildPayload(request.content, encoding)
    const tooLarge = contentTooLargeMessage(payload.bytes.length, normalizeMaxBytes(request.maxBytes))
    if (tooLarge !== undefined) rejectWrite(tooLarge)

    const workspaceRoot = await resolveRoot(request.workspaceRoot)
    const target = await resolveTarget(workspaceRoot, request.path)
    reportedPath = target.displayPath

    await ensureParentDirectory(target.absolutePath, request.createDirs ?? true)

    const archiveLock = request.exclusivePathLock
      ? await acquireLock(target.absolutePath)
      : undefined
    try {
      // 归档索引的自动压缩（Rust 的 `maybe_compact_subagent_index`）只在 `mode === 'append'` 且
      // 拿到了跨进程归档锁时跑（见 compaction.ts / compactionRules.ts 的文件头）。位置在归档锁
      // 之内、进程内写锁之外：compaction 改的是这次写入的同一个目标文件，需要跨进程互斥保护，
      // 但不需要（也不该）拿目标文件的进程内写锁——那把锁留给下面的临界区。压实失败按设计拒绝
      // 这次写入（`ok:false`，新内容不会被追加），对齐 Rust 把 `Err` 折成
      // `Ok(error_result(...))` 的行为，不是安静跳过一步。
      if (archiveLock !== undefined && mode === 'append') {
        await compactArchiveIndex(target.absolutePath)
      }
      return await withPathLock(target.absolutePath, () =>
        runWriteCriticalSection({
          target,
          workspaceRoot,
          mode,
          payload,
          expectedOldContent: request.expectedOldContent,
          expectedContentHash: request.expectedContentHash,
          executable: request.executable,
          dryRun: request.dryRun ?? false,
          journal: request.changeContext
            ? { directory: journalDirectory, context: request.changeContext }
            : undefined,
        }),
      )
    } finally {
      await archiveLock?.release()
    }
  } catch (error) {
    if (error instanceof WriteRejection) return errorResult(reportedPath, error.message)
    throw error
  }
}

function hasGuard(request: WriteWorkspaceFileRequest): boolean {
  return request.expectedOldContent !== undefined || request.expectedContentHash !== undefined
}

/** root 与目标路径的失败原样折进回执（Rust 同样是 `error_result(&path, err)`，不改写文案）。 */
async function resolveRoot(explicit: string | undefined): Promise<string> {
  try {
    return await resolveWorkspaceRoot(explicit)
  } catch (error) {
    return rejectWrite(errorText(error))
  }
}

async function resolveTarget(root: string, requested: string): Promise<ResolvedWriteTarget> {
  try {
    return await resolveWriteTarget(root, requested)
  } catch (error) {
    return rejectWrite(errorText(error))
  }
}

/**
 * 父目录不存在时按 `createDirs` 处理。默认建——缺父目录曾是首次写入最常见的失败，
 * 而「先建目录再写文件」对调用方是纯粹的往返开销。不建时给的错误自带出路。
 */
async function ensureParentDirectory(absolutePath: string, createDirs: boolean): Promise<void> {
  const parent = dirname(absolutePath)
  // 无父目录 = 已经是文件系统根，Rust 的 `path.parent()` 在那里给 None，整段跳过。
  if (parent === absolutePath) return
  if (await pathExists(parent)) return
  if (!createDirs) {
    rejectWrite('parent directory does not exist; set createDirs=true to create it')
  }
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    rejectWrite(`failed to create parent directories: ${errorText(error)}`)
  }
}

async function acquireLock(absolutePath: string): Promise<ArchivePathLock> {
  try {
    return await acquireArchivePathLock(absolutePath)
  } catch (error) {
    return rejectWrite(errorText(error))
  }
}

/** `maybeCompactSubagentIndex` 抛的是普通 Error；折成结构化拒绝是这里的事（同 `acquireLock`）。 */
async function compactArchiveIndex(absolutePath: string): Promise<void> {
  try {
    await maybeCompactSubagentIndex(absolutePath)
  } catch (error) {
    rejectWrite(errorText(error))
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
