// 覆盖/删除操作的乐观并发守卫：oldContent 与 expectedContentHash
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_guard.rs 整份。纯函数，不碰文件系统。
//
// 守卫比对的是**暂存表里的当前内容**，不是磁盘上的内容——同一批补丁里前一条操作刚改过的文件，
// 后一条的 oldContent 要按改过之后的样子给。这不是省事：批内每条都回磁盘对一次，等于宣称
// 「前面那些改动已经落盘了」，而 patch 的整个契约是全部成功才落盘。
//
// 两种证明二选一：整份旧文本，或它的 sha256。hash 的存在理由是不必为了证明「我读过」而把
// 整个文件再传一遍（read_workspace_file 返回的 `contentHash` 可以直接用在这里）。

import { createHash } from 'node:crypto'

const HASH_FORMAT_ERROR = 'expectedContentHash must use sha256:<64 lowercase hex characters>'
const HEX_64 = /^[0-9a-f]{64}$/

/**
 * 校验一个乐观守卫。两个都不给 = 不校验（调用方自己决定这时候该不该拒——覆盖已存在文件时
 * 必须给出其中一个，那条判断在暂存规则里，不在这里）。
 *
 * 顺序与 Rust 逐字一致：先拒「两个都给」，再比 oldContent，最后校验 hash 格式并比 hash。
 */
export function verifyStagedGuard(
  current: string,
  oldContent: string | undefined,
  expectedContentHash: string | undefined,
): void {
  if (oldContent !== undefined && expectedContentHash !== undefined) {
    throw new Error('pass either oldContent or expectedContentHash, not both')
  }
  if (oldContent !== undefined && oldContent !== current) {
    throw new Error('oldContent did not match current file content')
  }
  if (expectedContentHash !== undefined) {
    validateContentHash(expectedContentHash)
    if (contentSha256(current) !== expectedContentHash) {
      throw new Error(
        'expectedContentHash did not match current file content; re-read the file and retry with the new contentHash',
      )
    }
  }
}

/** 只收 `sha256:` + 64 位小写 hex。收严是有意的：大写 hex 与裸 hex 都拒，免得「格式对了但比不上」。 */
function validateContentHash(value: string): void {
  if (!value.startsWith('sha256:')) throw new Error(HASH_FORMAT_ERROR)
  if (!HEX_64.test(value.slice('sha256:'.length))) throw new Error(HASH_FORMAT_ERROR)
}

/**
 * 内容的 `sha256:<小写 hex>`。
 *
 * 哈希的是内容的 **UTF-8 字节**（Rust 是 `current.as_bytes()`），`digest('hex')` 与 Rust 的
 * `{:x}` 同为小写 hex。显式写 `'utf8'`：Node 的默认编码正是它，但写明才挡得住
 * 「哪天有人图省事传了个 Buffer」。
 */
function contentSha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}
