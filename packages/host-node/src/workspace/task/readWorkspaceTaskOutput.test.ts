import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readWorkspaceTaskOutput } from './readWorkspaceTaskOutput'

function readableOf(...chunks: readonly string[]): { stream: Readable; state: { pulled: number } } {
  const state = { pulled: 0 }
  async function* generate(): AsyncGenerator<Buffer> {
    for (const chunk of chunks) {
      state.pulled += 1
      yield Buffer.from(chunk)
    }
  }
  return { stream: Readable.from(generate()), state }
}

describe('readWorkspaceTaskOutput', () => {
  it('两路都在上限内时原样返回，不截断', async () => {
    const stdout = readableOf('out-a', 'out-b')
    const stderr = readableOf('err-a')

    const result = await readWorkspaceTaskOutput(stdout.stream, stderr.stream, 100)

    expect(result.stdout).toEqual({ text: 'out-aout-b', truncated: false })
    expect(result.stderr).toEqual({ text: 'err-a', truncated: false })
  })

  it('stdout 超限时用 drain 语义：读到 EOF 但只保留前 N 个字符，源全部被排空', async () => {
    // 100 块 × 10 字符，上限 5——若 stdout 用的是 stop 语义，只会拉走第 1 块就不再读了；
    // drain 语义必须把 100 块全部拉完（否则子进程会被写满的管道卡住），只是超出上限的部分丢弃。
    const stdout = readableOf(...Array.from({ length: 100 }, () => 'x'.repeat(10)))
    const stderr = readableOf('')

    const result = await readWorkspaceTaskOutput(stdout.stream, stderr.stream, 5)

    expect(result.stdout).toEqual({ text: 'xxxxx', truncated: true })
    expect(stdout.state.pulled).toBe(100)
  })

  it('stderr 超限同样 drain 到底：源被排空，避免写端卡死子进程', async () => {
    const stdout = readableOf('')
    const stderr = readableOf(...Array.from({ length: 50 }, () => 'e'.repeat(4)))

    const result = await readWorkspaceTaskOutput(stdout.stream, stderr.stream, 3)

    expect(result.stderr).toEqual({ text: 'eee', truncated: true })
    expect(stderr.state.pulled).toBe(50)
  })

  it('两路并发读取：调用即发起，不必等调用方 await 才开始消费', async () => {
    const stdout = readableOf('a', 'b', 'c')
    const stderr = readableOf('x', 'y', 'z')

    const promise = readWorkspaceTaskOutput(stdout.stream, stderr.stream, 10)
    // 不立即 await：给事件循环一轮机会，两路应当已经在并发消费，而不是排队等对方读完。
    await new Promise((resolve) => setTimeout(resolve, 10))

    const result = await promise
    expect(result.stdout.text).toBe('abc')
    expect(result.stderr.text).toBe('xyz')
  })
})
