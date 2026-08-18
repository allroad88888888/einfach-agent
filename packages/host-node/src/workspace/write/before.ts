// 锁内一次性读到的「写之前磁盘上是什么」
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_before.rs。
//
// 【为什么是一次读、三处用】
// 乐观守卫、回滚日志、变更摘要都要旧内容。各读各的话，三次读之间文件可能变——守卫比的是第一次
// 读到的内容、日志记的是第二次读到的内容，回滚就会把一份从未存在过的状态写回磁盘。所以流水线
// 在进程内写锁里读**一次**，把这个值传给三方。
//
// 【「读不出来」不是错误，是一种状态】
// 存在但读不成可逆文本的文件（二进制、非 UTF-8、超过硬上限、不是普通文件）报成 `unsupported`
// 并带上理由，而不是抛错：只有真正需要旧字节的调用方（乐观守卫、要保持可逆的日志写入）才会
// 因此失败；一次普通的二进制覆盖照常进行，只是没有变更摘要、也标明不可逆。
//
// 【一处照搬未改的 Rust 文案】
// 超过硬上限时说的是 `existing file exceeds reversible {MAX_BYTES} byte limit`，而 `MAX_BYTES`
// 是 8 MiB 的写入硬顶、`REVERSIBLE_MAX_BYTES`（1 MiB）才是可逆预算——"reversible" 这个词与它
// 实际用的常量对不上。判定与文案都在 W5 的 `beforeExceedsReversibleBudget` 里，理由见那里：
// 错误文案是两个宿主的对外契约，改一个字就是制造分叉。

import type { Buffer } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import { errorText } from '../common'
import { beforeExceedsReversibleBudget } from './limitChecks'

/** 写之前磁盘上的内容。三态，不是 `string | null`——「读不出来」要带得出理由。 */
export type BeforeContent =
  | { kind: 'missing' }
  | { kind: 'text'; text: string }
  /** 存在，但不是可逆的 UTF-8 文本；`reason` 会原样成为回执里的 `reversible_reason`。 */
  | { kind: 'unsupported'; reason: string }

/** 文件当时存在吗。`unsupported` 也算存在——读不出来不等于没有。 */
export function beforeExisted(before: BeforeContent): boolean {
  return before.kind !== 'missing'
}

/** 可用的旧文本；不是 `text` 态时为 `null`（日志的 `before` 字段正是这个语义）。 */
export function beforeText(before: BeforeContent): string | null {
  return before.kind === 'text' ? before.text : null
}

/**
 * 读一次旧内容，供守卫、日志与摘要共用。
 *
 * 判定顺序与 Rust 逐条一致：stat 失败 → 不存在；不是普通文件 → 不支持；超过硬上限 → 不支持
 * （**先看 size 再读**，否则 8 GiB 的文件会被整份读进内存）；含 NUL → 二进制；非 UTF-8 → 不支持。
 *
 * 解码用 `fatal: true`（默认会把非法字节悄悄换成 `�`，那样「非 UTF-8 拒收」这条就没了）加
 * `ignoreBOM: true`（默认会**吃掉**开头的 U+FEFF，而 Rust 的 `String::from_utf8` 原样保留——
 * 少了这三个字节，守卫比对与回滚内容都会与桌面端对不上）。
 */
export async function readBeforeContent(path: string): Promise<BeforeContent> {
  let size: number
  try {
    const stats = await stat(path)
    if (!stats.isFile()) return { kind: 'unsupported', reason: 'rollback only supports regular files' }
    size = stats.size
  } catch {
    return { kind: 'missing' }
  }

  const tooLarge = beforeExceedsReversibleBudget(size)
  if (tooLarge !== undefined) return { kind: 'unsupported', reason: tooLarge }

  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    return { kind: 'unsupported', reason: `failed to read file for rollback: ${errorText(error)}` }
  }
  if (bytes.includes(0)) {
    return { kind: 'unsupported', reason: 'binary files are not reversible' }
  }
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  } catch {
    return { kind: 'unsupported', reason: 'non-UTF-8 files are not reversible' }
  }
}
