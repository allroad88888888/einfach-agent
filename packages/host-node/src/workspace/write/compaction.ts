// 归档索引自动压缩：IO 编排
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_compaction.rs 的 `maybe_compact_subagent_index`。
// 纯逻辑（路径判定、节流判定、JSONL 去重合并）在 compactionRules.ts；本文件只做磁盘交互：
// 读大小、读/写 marker 的 mtime、读原文件、整份重写、刷新节流戳。
//
// 调用方（pipeline.ts）只在 `mode === 'append' && exclusivePathLock` 时调用本函数，且此时已经
// 持有跨进程归档锁——多进程互斥交给锁层，这里不必关心并发写入。
//
// 【失败即结构化拒绝，不是安静跳过】
// Rust 的 `maybe_compact_subagent_index` 返回 `Result<(), String>`，调用点把 `Err` 折成
// `Ok(error_result(...))`——压实失败会让整条 `write_workspace_file` 调用失败（新内容不会被
// 追加），不是「压不动就算了」。本文件同 lockArchive.ts 的约定，统一 `throw new Error(...)`，
// 折成 `WriteRejection` 是 pipeline.ts 的事（同 `acquireLock` 那层包装）。
//
// 【节流状态存在哪、跨进程怎么办】
// 节流戳是磁盘上一个真实的 sibling 文件（`.{name}.compact-at`），不是进程内内存——多个进程
// 天然共享同一份文件系统状态，不需要额外的跨进程同步机制。判据只看这个文件的 **mtime**，
// 不看它写进去的内容（Rust 同样只用 `fs::metadata(...).modified()`，写进去的
// `now_millis().to_string()` 只是为了产生一次真实的写操作从而刷新 mtime，内容本身不参与判断）。
// 又因为压实全程发生在跨进程归档锁内（调用方保证），两个进程不会同时压同一个文件。
//
// 【与 Rust 唯一刻意不同的一步：整份替换走谁】
// Rust 这里另起了一个本地 `atomic_replace`——`fs::write` + `fs::rename`，既不 fsync 也不回填
// 权限位（继承的是临时文件的 umask 权限），与 `workspace_common.rs` 的共享 `atomic_write`
// 不是同一份实现（那份两者都做）。这是移植时发现的 Rust 侧不一致，已报告给主会话；Node 侧
// 统一走 N2 的共享 `atomicWrite`（含 fsync + 权限回填），与 write 域别处一致——这是任务书的
// 明确指令，不是本卡自行改动。压实产出的内容字节不变，只是落盘更耐久。

import { readFile, stat, writeFile } from 'node:fs/promises'
import { atomicWrite, errorText } from '../common'
import {
  compactSubagentIndex,
  indexCompactionMarkerPath,
  isCompactionThrottled,
  subagentIndexName,
} from './compactionRules'
import { INDEX_COMPACT_MAX_BYTES, INDEX_COMPACT_MIN_BYTES, INDEX_COMPACT_THROTTLE_MS } from './limits'

export interface CompactSubagentIndexOptions {
  /** 覆盖节流窗口，测试专用——同 lockArchive.ts 的 waitMs/staleMs，5 分钟等不起。 */
  throttleMs?: number
}

/**
 * 视情况压实一次子 Agent 归档索引。只对
 * `.webAgent-archive/index/{runs,skills,agents}.jsonl` 生效，其余路径（含 events.jsonl）
 * 原样跳过，函数直接返回。
 */
export async function maybeCompactSubagentIndex(
  absolutePath: string,
  options: CompactSubagentIndexOptions = {},
): Promise<void> {
  const name = subagentIndexName(absolutePath)
  if (name === undefined) return

  const size = await statSizeOrUndefined(name, absolutePath)
  if (size === undefined) return // 文件不存在：还没有可压的内容
  if (size < INDEX_COMPACT_MIN_BYTES) return
  if (size > INDEX_COMPACT_MAX_BYTES) {
    throw new Error(`${name} index exceeds automatic compaction limit of ${INDEX_COMPACT_MAX_BYTES} bytes`)
  }

  const markerPath = indexCompactionMarkerPath(absolutePath, name)
  const throttleMs = options.throttleMs ?? INDEX_COMPACT_THROTTLE_MS
  const markerAgeMs = await markerAge(markerPath)
  if (markerAgeMs !== undefined && isCompactionThrottled(markerAgeMs, throttleMs)) return

  const text = await readFile(absolutePath, 'utf8').catch((error: unknown) => {
    throw new Error(`failed to read ${name} index for compaction: ${errorText(error)}`)
  })
  const compacted = compactSubagentIndex(name, text)
  await atomicWrite(absolutePath, compacted)
  await writeFile(markerPath, String(Date.now())).catch((error: unknown) => {
    throw new Error(`failed to update ${name} compaction marker: ${errorText(error)}`)
  })
}

async function statSizeOrUndefined(name: string, absolutePath: string): Promise<number | undefined> {
  try {
    const stats = await stat(absolutePath)
    return stats.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`failed to inspect ${name} index for compaction: ${errorText(error)}`)
  }
}

/**
 * marker 距上次刷新过了多久；marker 不存在（从没压过）返回 `undefined`。
 *
 * mtime 先向下取整到毫秒——与 `lockArchive.ts` 的 `archiveLockAgeMs` 同一个理由：
 * `stats.mtimeMs` 是亚毫秒精度，`Date.now()` 只有毫秒精度，直接相减在两次读数落在同一毫秒内
 * 时会得到一个微小负值，被 `isCompactionThrottled` 的「未来时间戳不算节流」分支误判成
 * 「还没到节流窗口」从而白白多压一次。Rust 两边都是纳秒精度，没有这个错配，这纯粹是 Node
 * 的读数精度问题，不是行为分歧。
 */
async function markerAge(markerPath: string): Promise<number | undefined> {
  try {
    const stats = await stat(markerPath)
    return Date.now() - Math.floor(stats.mtimeMs)
  } catch {
    return undefined
  }
}
