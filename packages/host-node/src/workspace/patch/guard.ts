// 覆盖/删除操作的乐观并发守卫：oldContent 与 expectedContentHash
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_guard.rs（已随 T1 删除）整份。纯函数，不碰文件系统。
//
// 守卫比对的是**暂存表里的当前内容**，不是磁盘上的内容——同一批补丁里前一条操作刚改过的文件，
// 后一条的 oldContent 要按改过之后的样子给。这不是省事：批内每条都回磁盘对一次，等于宣称
// 「前面那些改动已经落盘了」，而 patch 的整个契约是全部成功才落盘。
//
// 两种证明二选一：整份旧文本，或它的 sha256。hash 的存在理由是不必为了证明「我读过」而把
// 整个文件再传一遍（read_workspace_file 返回的 `contentHash` 可以直接用在这里）。

import { Buffer } from 'node:buffer'
import {
  CONTENT_HASH_FORMAT_ERROR,
  contentSha256,
  hasValidContentHashFormat,
} from '../common/contentHash'

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
    if (!hasValidContentHashFormat(expectedContentHash)) {
      throw new Error(CONTENT_HASH_FORMAT_ERROR)
    }
    if (contentSha256(Buffer.from(current, 'utf8')) !== expectedContentHash) {
      throw new Error(
        'expectedContentHash did not match current file content; re-read the file and retry with the new contentHash',
      )
    }
  }
}
