// 写前乐观守卫：拿锁内读到的旧内容核对调用方声明的前置状态
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_guard.rs（已随 T1 删除）。
//
// 【它比对的是**已经读到手的** before，不是现读一次】
// 函数签名收 `BeforeContent` 而不是路径，是这条守卫成立的前提：现读一次的话，「读→比→写」之间
// 又开了一个窗口，而这个窗口正是守卫要消灭的东西。流水线在进程内写锁里读一次、把值传进来，
// 校验与随后的落盘之间因此没有任何让出点（W6 的锁把跨 await 的交错也堵上了）。
//
// 【不匹配时给什么：一句能照着做的话，不是「失败了」】
// 这是模型撞上并发修改时唯一的线索，所以两条失败各自带着出路：
//   · `expectedOldContent` 不匹配 → 附上**双方的字节数、第一个不同的字节位置、各自结尾的换行
//     个数**，并明说要重读完整文件、连结尾换行一起原样传、不要传片段。模型最常见的错法就是
//     传一段掐头去尾的片段或漏掉末尾换行，这几个数字直接指出是哪一种。
//   · `expectedContentHash` 不匹配 → 明说「read_file 之后文件被改过」，出路是重读拿新的
//     contentHash 再试。**不回传当前实际 hash**——照搬 Rust。给了也没用：模型拿一个 hash 无法
//     推出内容，该做的仍是重读；而重读那一步本来就会给出新的 contentHash。
// 两条都不带路径（路径由流水线折进回执的 `path` 字段），也都不带文件内容。
//
// 【格式校验收得很严，有意的】
// 只认 `sha256:` + 64 位**小写** hex。大写 hex 与裸 hex 一律拒——放行的话会变成「格式看着对、
// 就是比不上」，模型会反复重试同一个错值；报格式错至少说得清哪里不对。

import { Buffer } from 'node:buffer'
import {
  CONTENT_HASH_FORMAT_ERROR,
  contentSha256,
  hasValidContentHashFormat,
} from '../common/contentHash'
import { rejectWrite } from './result'
import type { BeforeContent } from './before'

/**
 * 校验乐观守卫。两个都没给 = 不校验（要不要求给守卫是流水线按模式判的，不在这里）。
 * 不通过就按设计拒绝（`WriteRejection`），文案与 Rust 逐字一致。
 */
export function verifyExpectedContent(
  before: BeforeContent,
  expected: string | undefined,
  expectedHash: string | undefined,
): void {
  if (expected !== undefined && expectedHash !== undefined) {
    rejectWrite('pass either expectedOldContent or expectedContentHash, not both')
  }
  if (expected === undefined && expectedHash === undefined) return

  if (before.kind === 'missing') {
    rejectWrite('failed to read existing file for optimistic guard: file does not exist')
  }
  if (before.kind === 'unsupported') {
    rejectWrite(`failed to read existing file for optimistic guard: ${before.reason}`)
  }
  const current = before.text

  if (expected !== undefined && current !== expected) {
    rejectWrite(mismatchMessage(expected, current))
  }
  if (expectedHash !== undefined) {
    if (!hasValidContentHashFormat(expectedHash)) rejectWrite(CONTENT_HASH_FORMAT_ERROR)
    if (contentSha256(Buffer.from(current, 'utf8')) !== expectedHash) {
      rejectWrite(
        'expectedContentHash does not match current file content; the file changed after ' +
          'read_file. Re-read it and retry with the new contentHash',
      )
    }
  }
}

/**
 * 差异形状的描述。全部按**字节**算——Rust 的 `String::len()` 与 `as_bytes()` 都是字节，
 * 直译成 `.length` 会让含中文的内容报出只有实际值三分之一的位置，模型照着那个数字去找，
 * 找到的是另一处。
 */
function mismatchMessage(expected: string, current: string): string {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const currentBytes = Buffer.from(current, 'utf8')
  return (
    'expectedOldContent does not match current file content ' +
    `(expected_bytes=${expectedBytes.length}, current_bytes=${currentBytes.length}, ` +
    `first_mismatch_byte=${firstMismatchByte(expectedBytes, currentBytes)}, ` +
    `expected_trailing_lf=${trailingLfCount(expectedBytes)}, ` +
    `current_trailing_lf=${trailingLfCount(currentBytes)}). ` +
    'Re-read the complete, untruncated file and pass it exactly, including final newlines; ' +
    'do not pass a snippet'
  )
}

/** 第一个不同的字节位置；一方是另一方的前缀时，取较短的那个长度（= 分歧开始处）。 */
function firstMismatchByte(expected: Buffer, current: Buffer): number {
  const shared = Math.min(expected.length, current.length)
  for (let index = 0; index < shared; index += 1) {
    if (expected[index] !== current[index]) return index
  }
  return shared
}

/** 结尾连续的 `\n` 个数。「少传/多传一个末尾换行」是最常见的一种不匹配，单独报出来。 */
function trailingLfCount(content: Buffer): number {
  let count = 0
  while (count < content.length && content[content.length - 1 - count] === 0x0a) count += 1
  return count
}
