import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { captureOutput } from './outputCapture'

/** 让事件循环转几圈，够读端把已 push 的块消化掉。 */
function settleIo(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

/** 字节流。子进程的 stdout/stderr 给的就是 Buffer，测试里也别用字符串（那是 objectMode）。 */
function byteStream(...chunks: readonly string[]): Readable {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)))
}

describe('captureOutput', () => {
  it('读到 EOF 时给出完整文本', async () => {
    const capture = captureOutput(byteStream('abc', 'def'), 'stdout', 100)

    await capture.done

    expect(capture.settled).toBe(true)
    expect(capture.take()).toEqual({ text: 'abcdef', truncated: false })
    expect(capture.failure).toBeUndefined()
  })

  it('超上限时一路读到 EOF，只是多出来的部分读了就扔', async () => {
    // 这是 stdout/stderr 都用 drain 的那条判据：读端一停，写端就会卡在满掉的管道上，
    // 子进程再也走不到退出。所以到上限之后仍然要把源读空。
    const source = byteStream('0123456789', '0123456789')

    const capture = captureOutput(source, 'stdout', 5)
    await capture.done

    expect(capture.take()).toEqual({ text: '01234', truncated: true })
    expect(source.readableEnded).toBe(true)
  })

  it('放弃时交出已读到的部分，并销毁流', async () => {
    // 孤儿孙进程握着写端时永远等不到 EOF——这条用例就是那个场景的最小复现：
    // 流一直开着，但读端必须能在任意时刻脱身，且不丢已经读到的内容。
    // （销毁会让挂起的 next() 以 ERR_STREAM_PREMATURE_CLOSE reject；没接住的话
    // 整个测试进程会被未处理拒绝掀翻，所以这条用例同时在盯那个 handler。）
    const source = new Readable({ read() {} })
    source.push(Buffer.from('partial'))
    const capture = captureOutput(source, 'stdout', 100)
    await settleIo()
    expect(capture.settled).toBe(false)

    capture.abandon()
    await capture.done

    expect(capture.settled).toBe(true)
    expect(capture.take()).toEqual({ text: 'partial', truncated: false })
    expect(source.destroyed).toBe(true)
  })

  it('读失败记在 failure 上，done 不 reject', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('boom'))
      },
    })

    const capture = captureOutput(source, 'stderr', 100)
    await expect(capture.done).resolves.toBeUndefined()

    expect(capture.failure?.message).toBe('failed to read child stderr: boom')
    expect(capture.take()).toEqual({ text: '', truncated: false })
  })
})
