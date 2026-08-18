// 子进程一条输出管道的捕获：带上限、可随时放弃、放弃后仍交出已读到的部分
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_output.rs（Rust 那边是「一个读线程 + Arc<Mutex<..>> 共享缓冲」）。
//
// 【为什么 stdout 和 stderr 都用 readCappedDrain，没有一个用 readCappedStop】
// Rust 的 `read_capped_into` 到上限之后**继续 read**、只是把内容丢掉（只记一笔 truncated），
// 两条流用的是同一个函数——也就是 drain 语义。这不是随手写的：管道缓冲只有几十 KiB，
// 读端一停，写端就在下一次 write 上阻塞，子进程再也走不到退出那一步。于是「输出超过上限」
// 会变成「命令挂住直到超时被杀」，exit_code 从 0 变成 null。stdout 尤其如此——它恰恰是
// 最可能吐满上限的那条流。
// `readCappedStop`（到上限就不再取下一块）适用的是「读完就走、剩下的交给调用方处置」的场景，
// 比如读一个文件；对活着的子进程管道用它就是自找死锁。
//
// 【为什么不能直接 await readCappedDrain 的 promise 就完事】
// 直接子进程退出后，管道写端可能还被它派生的后台孙进程握着（`cmd &`、nohup），这时读端
// 永远等不到 EOF。Rust 的做法是「放弃那个线程，从共享缓冲里取走已捕获的部分」；Node 这边
// 更彻底：`abandon()` 让喂给 readCappedDrain 的那个异步迭代器就地结束，于是它**正常
// resolve**、返回的正是已读到的部分，然后销毁流释放 fd。Rust 泄漏一个线程加一个 fd，
// Node 一个都不留——这是宿主能力的差异，不是语义的改动（两边交出的文本相同）。

import type { Readable } from 'node:stream'
import { errorText, readCappedDrain, type ByteSource, type CappedRead } from '../workspace/common'

/** 一条流的捕获过程。`done` 永不 reject——读失败记在 `failure` 上，由 drain 决定怎么报。 */
export interface OutputCapture {
  /** 流名，只用于错误文案（`failed to read child stdout: …`）。 */
  readonly stream: 'stdout' | 'stderr'
  /** 读到 EOF、被放弃、或读失败之后为 true。 */
  readonly settled: boolean
  /** 结束信号。永不 reject。 */
  readonly done: Promise<void>
  /** 读失败时的错误，文案对齐 Rust 的 `join_output_reader`。 */
  readonly failure: Error | undefined
  /** 放弃继续读：结束迭代并销毁流。已读到的部分照常从 `take()` 取。 */
  abandon: () => void
  /** 已捕获的文本与截断标记。`settled` 之前是空的。 */
  take: () => CappedRead
}

const ABANDONED = Symbol('abandoned')

export function captureOutput(
  source: Readable,
  stream: 'stdout' | 'stderr',
  maxChars: number,
): OutputCapture {
  let signalAbandon = (): void => {}
  const abandoned = new Promise<typeof ABANDONED>((resolve) => {
    signalAbandon = () => resolve(ABANDONED)
  })

  let settled = false
  let captured: CappedRead = { text: '', truncated: false }
  let failure: Error | undefined

  const done = readCappedDrain(abandonableChunks(source, abandoned), maxChars)
    .then(
      (result) => {
        captured = result
      },
      (error: unknown) => {
        failure = new Error(`failed to read child ${stream}: ${errorText(error)}`)
      },
    )
    .then(() => {
      settled = true
    })

  return {
    stream,
    get settled() {
      return settled
    },
    done,
    get failure() {
      return failure
    },
    abandon: () => {
      // 先给迭代循环发信号、再销毁流：反过来的话，销毁引发的 ERR_STREAM_PREMATURE_CLOSE
      // 会先赢下竞速，把一次主动放弃记成一次读失败。
      signalAbandon()
      source.destroy()
    },
    take: () => captured,
  }
}

/**
 * 把一条流包成「可以中途放弃」的字节源。
 *
 * readCappedDrain 只认 `AsyncIterable<Uint8Array>`，而流自己的异步迭代器一旦停在
 * `next()` 上就只能等 EOF。这里用竞速给它加一条出路：放弃信号一到就 return，
 * 消费方的 `for await` 随之正常结束。
 */
async function* abandonableChunks(
  source: ByteSource,
  abandoned: Promise<typeof ABANDONED>,
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  for (;;) {
    const step = iterator.next()
    // 竞速里落选的那条腿仍活着：流被 destroy 时它会以 ERR_STREAM_PREMATURE_CLOSE reject。
    // Node 里没有 handler 的 rejection 默认直接终止进程，所以先挂一个空 handler。
    step.catch(() => {})
    const next = await Promise.race<IteratorResult<Uint8Array> | typeof ABANDONED>([step, abandoned])
    if (next === ABANDONED || next.done === true) return
    yield next.value
  }
}
