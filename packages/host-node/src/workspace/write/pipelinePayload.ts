// content 入参 → 要落盘的字节 + 它是否还能当文本看
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_write_pipeline.rs:133-150（已随 T1 删除）那一段。拆出来是因为它回答的是
// 一个独立问题：「调用方给的这串东西，落到磁盘上是哪些字节，以及这次写入还能不能被回滚」。
//
// 【一份字节视图，四种模式共用；文本视图只影响可逆性与 diff】
// 落盘一律用 `bytes`。`text` 只在两处被用到：变更日志（回滚要存完整的前后文本）与变更摘要
// （行级 diff）。所以 `text === null` 不代表写不了，只代表这次写入撤不回来、也给不出 diff。
//
// 【base64 承载的可能是文本，不能一律当二进制】
// 模型有时会为了绕开引号转义而把一段普通文本 base64 过来。解出来若是合法 UTF-8 且不含 NUL，
// 就仍按文本对待——否则一次「用 base64 传的中文」会白白失去回滚能力。判据与 Rust 逐字一致：
// `String::from_utf8(...).ok().filter(|text| !text.contains('\0'))`。
//
// base64 解码本身（严格 RFC 4648，非法输入报错而不是像 `Buffer.from` 那样静默吞掉垃圾字节）
// 是 `base64.ts` 的职责，见那边的模块注释。

import { Buffer } from 'node:buffer'
import { decodeBase64 } from './base64'
import type { ContentEncoding } from './types'

export interface WritePayload {
  /** 落盘的字节。所有模式、所有编码都以它为准。 */
  bytes: Uint8Array
  /** 同一份内容的文本视图；`null` = 二进制（不可逆、无 diff）。 */
  text: string | null
}

/** 把 `content` 按编码解成待写字节。解不出来即按设计拒绝，磁盘一个字节都不碰。 */
export function buildPayload(content: string, encoding: ContentEncoding): WritePayload {
  if (encoding === 'utf8') {
    return { bytes: Buffer.from(content, 'utf8'), text: content }
  }
  const bytes = decodeBase64(content)
  return { bytes, text: recoverPayloadText(bytes) }
}

/**
 * 解码后的字节还能不能当文本看。base64 路径解码成功后调用——留在这里是因为「合法
 * UTF-8 且不含 NUL 才算文本」这条判据属于 payload 的语义，不属于 base64 解码器。
 */
export function recoverPayloadText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    // `ignoreBOM: true` 与 read 域同款：默认会吃掉开头的 U+FEFF，而 Rust 的 `String::from_utf8`
    // 原样保留——被吃掉的话写进日志的文本比磁盘上的少三个字节，回滚后文件就变了。
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}
