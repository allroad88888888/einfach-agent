// 文件快照的构造与「还是不是原样」判定
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_types.rs 里 `impl FileSnapshot` 的两个方法。
// 纯函数，不碰文件系统——「把磁盘上的文件读成快照」是回滚侧（W15）的 IO，不在这里。
//
// 为什么要存 hash 而不是只存 content：回滚前要判断「这个文件自那次工具调用之后有没有被人改过」，
// 判据是 `same_state`，它**只比 exists 与 hash，不比 content**。这不是省事——是让判定与「条目里
// 是否携带了内容」解耦：将来若给超大文件改成只记 hash 不记正文，冲突检测那一侧一行都不用动。

import { createHash } from 'node:crypto'
import type { FileSnapshot } from './types'

/**
 * 由文本内容构造快照。`null` 表示那一刻文件不存在。
 *
 * hash 是内容 **UTF-8 字节**的 sha256、十六进制小写，与 Rust 的 `format!("{:x}", ...)` 同款。
 * `update(content, 'utf8')` 与 Rust 的 `value.as_bytes()` 逐字节相同——注意别改成默认编码，
 * Node 的默认是 utf8 没错，但写明它才挡得住「哪天有人图省事传了个 Buffer」。
 */
export function fileSnapshotFromContent(content: string | null): FileSnapshot {
  return {
    exists: content !== null,
    hash: content === null ? null : createHash('sha256').update(content, 'utf8').digest('hex'),
    content,
  }
}

/**
 * 两个快照是否描述同一个状态。
 *
 * 刻意**不比 content**：见文件头。两边都是 `exists: false` 时 hash 同为 null，照样相等。
 */
export function sameSnapshotState(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists && left.hash === right.hash
}
