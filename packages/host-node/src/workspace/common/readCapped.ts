// 带上限的增量读：两个变体，差别是「到上限之后还读不读」
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs（已随 T1 删除）的 `read_capped_stop` / `read_capped_drain`。
//
// 要点是**「带上限」不等于「读完再截断」**：`await text(stream)` 之后 `slice(0, cap)` 也能得到
// 同样的返回值，但那时整份输出已经全在内存里了——一个 `git diff` 或跑飞的构建脚本能吐几百 MB，
// 上限是防它撑爆进程的，不是给结果美容的。所以两个变体都是**边读边判**，保留的文本永远不超过
// 上限一个块。
//
// 两个变体的差别（也是它们为什么不能合成一个）：
//   · stop —— 一到上限就**不再读**，立刻返回。给 stdout 这种「读它是为了拿内容」的流：内容
//     够了就该停手，调用方据 `truncated` 去杀子进程 / 关管道。
//   · drain —— 一路读到 EOF，只是超出上限的部分**读了就扔**。给 stderr 这种「读它是为了不让
//     管道堵死」的流：不排空，写端会在管道缓冲写满时阻塞，子进程就此挂住，谁也等不到退出码。
//     （Rust 侧正是为此专门开一个线程 drain stderr。）
//
// 本模块**不主动关闭/销毁 source**。Rust 版同样只是 return，由调用方 `child.kill()` 再
// `drop(stdout)`。在 Node 里若在这里对迭代器调 `return()`，Readable 会被 destroy、子进程收到
// EPIPE——那是替调用方做了处置决定，而它可能还想先读退出码或 stderr。谁开的谁关。

import { StringDecoder } from 'node:string_decoder'
import { countCodePoints, takeCodePoints } from './codePoints'

/** 带上限的读结果：已读文本 + 是否被上限截断。等价 Rust 的 `CappedRead`。 */
export interface CappedRead {
  text: string
  truncated: boolean
}

/** 字节流。Node 的 `Readable`（含子进程的 stdout/stderr）天然满足这个形状。 */
export type ByteSource = AsyncIterable<Uint8Array>

/**
 * 增量读到码点上限即停——达到上限后**不再从 source 取下一块**。
 *
 * `maxChars <= 0` 时一块都不读、直接返回 `truncated: true`（Rust 的循环同样是先判上限再读）。
 */
export async function readCappedStop(source: ByteSource, maxChars: number): Promise<CappedRead> {
  const sink = new CappedSink(maxChars)
  const iterator = source[Symbol.asyncIterator]()
  while (!sink.isFull) {
    const next = await iterator.next()
    if (next.done === true) return sink.finish()
    sink.push(next.value)
  }
  // 到上限就地返回，剩下的字节留在流里——由调用方决定杀进程还是关管道。
  return { text: sink.text, truncated: true }
}

/**
 * 增量读到 EOF，但只保留前 `maxChars` 个码点，多出的部分读了就丢。
 * 用于**必须排空**的管道（子进程 stderr），否则写端会被撑满的管道阻塞住。
 */
export async function readCappedDrain(source: ByteSource, maxChars: number): Promise<CappedRead> {
  const sink = new CappedSink(maxChars)
  for await (const chunk of source) sink.push(chunk)
  return sink.finish()
}

/**
 * 两个变体共用的累积器：解码、按码点数封顶、记 truncated。
 *
 * 解码用 `StringDecoder` 而**不是**逐块 `Buffer.toString('utf8')`——这是本移植里唯一一处
 * 有意偏离 Rust 的地方，理由见 index.ts 的说明。它会把块尾不完整的多字节序列留到下一块，
 * 因此一个汉字被 8 KiB 块边界劈开时仍然解成那个汉字。
 */
class CappedSink {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxChars: number
  private written = 0
  private truncated = false
  text = ''

  constructor(maxChars: number) {
    this.maxChars = maxChars
    // 上限为 0 时「一个码点都放不下」本身就是截断——即使流是空的，Rust 也返回 truncated: true。
    this.truncated = maxChars <= 0
  }

  get isFull(): boolean {
    return this.written >= this.maxChars
  }

  push(chunk: Uint8Array): void {
    this.append(this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  }

  /** 收尾：把 decoder 里残留的不完整序列吐出来（会成为替换字符），再报结果。 */
  finish(): CappedRead {
    this.append(this.decoder.end())
    return { text: this.text, truncated: this.truncated }
  }

  private append(decoded: string): void {
    if (!decoded) return
    if (this.isFull) {
      // 已满：内容直接丢弃，只记一笔截断。drain 变体全靠这一步做到「读而不留」。
      this.truncated = true
      return
    }
    const remaining = this.maxChars - this.written
    const decodedCount = countCodePoints(decoded)
    if (decodedCount <= remaining) {
      this.text += decoded
      this.written += decodedCount
      return
    }
    this.text += takeCodePoints(decoded, remaining)
    this.written = this.maxChars
    this.truncated = true
  }
}
