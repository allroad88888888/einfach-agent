// change id 的合法性，以及它在日志目录里的两个文件名
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_store.rs 的 `validate_change_id` /
// `entry_path` / `payload_path`。
//
// 校验和命名放同一个文件，是因为它们本来就是一件事：**change id 会被原样拼进文件路径**，那张
// 白名单就是这次拼接的安全前提。把它们分开，读到 `entryPath` 的人看不到「凭什么这样拼是安全的」，
// 而 id 是调用方（core 的 runtime）给的字符串——`../../../etc/passwd` 或 `a/b` 一旦放行，日志条目
// 就写到日志目录外面去了。

import { join } from 'node:path'

/**
 * ASCII 字母数字加 `-` `_`，且非空。
 *
 * 与 Rust 的逐字节判定等价：Rust 遍历 `bytes()` 要求每个字节 `is_ascii_alphanumeric()` 或 `-`/`_`，
 * 任何非 ASCII 字节都会失败；JS 的字符类同样只放行这 64 个 ASCII 字符，多字节字符一律不匹配。
 */
const CHANGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 校验 change id，不合法就抛。错误文案跟随 Rust 原文。
 *
 * 每个以 change id 为入口的公开函数都要先过这一道——**包括只做路径拼接、不碰磁盘的那些**。
 * 「反正后面还会校验」是这类漏洞的标准死法。
 */
export function validateChangeId(changeId: string): void {
  if (!CHANGE_ID_PATTERN.test(changeId)) throw new Error('invalid workspace change id')
}

/** 条目文件：`<directory>/<changeId>.json`。调用前必须已经 `validateChangeId`。 */
export function entryPath(directory: string, changeId: string): string {
  return join(directory, `${changeId}.json`)
}

/**
 * 载荷路径：`<directory>/<changeId>.payload`。调用前必须已经 `validateChangeId`。
 *
 * 只有可恢复删除用得上：被删掉的内容整份挪到这里，而不是塞进条目 JSON。删除的可能是一整棵目录树
 * ——序列化进 JSON 既撑爆条目，也丢掉权限位和目录结构。所以它可能是**文件也可能是目录**，清理时
 * 两种都要能删掉（见 prepare.ts 的 `discardPreparedChange`）。
 */
export function payloadPath(directory: string, changeId: string): string {
  return join(directory, `${changeId}.payload`)
}
