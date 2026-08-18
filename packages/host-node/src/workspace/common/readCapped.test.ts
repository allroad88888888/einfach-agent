import { describe, expect, it } from 'vitest'
import { readCappedDrain, readCappedStop, type ByteSource } from './readCapped'

interface ProbedSource {
  source: ByteSource
  /** 已经被取走的块数——「到上限就不再读」这条只能靠它证明。 */
  readonly state: { pulled: number; closed: boolean }
}

/** 把若干块包成一个可观测的字节流：记录被取走多少块、生成器有没有被关闭。 */
function probedSource(chunks: readonly Uint8Array[]): ProbedSource {
  const state = { pulled: 0, closed: false }
  async function* generate(): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of chunks) {
        state.pulled += 1
        yield chunk
      }
    } finally {
      state.closed = true
    }
  }
  return { source: generate(), state }
}

function utf8Chunks(...values: readonly string[]): Uint8Array[] {
  return values.map((value) => new TextEncoder().encode(value))
}

describe('readCappedStop', () => {
  it('到上限即停：不再从流里取下一块，也不把整份输出缓冲起来', async () => {
    // 源里有 1000 × 100 = 100000 个字符，上限 250。若实现是「读完再截断」，pulled 会是 1000、
    // 内存里也会先攒满 100000 个字符——那正是这个上限要防的事。
    const chunks = utf8Chunks(...Array.from({ length: 1000 }, () => 'x'.repeat(100)))
    const { source, state } = probedSource(chunks)

    const result = await readCappedStop(source, 250)

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('x'.repeat(250))
    expect(state.pulled).toBe(3)
  })

  it('不主动关闭流：处置权留给调用方（杀子进程还是关管道由它决定）', async () => {
    const { source, state } = probedSource(utf8Chunks(...Array.from({ length: 50 }, () => 'ab')))

    await readCappedStop(source, 4)

    expect(state.closed).toBe(false)
  })

  it('流在上限内结束时不算截断', async () => {
    const { source, state } = probedSource(utf8Chunks('hello ', 'world'))

    await expect(readCappedStop(source, 100)).resolves.toEqual({
      text: 'hello world',
      truncated: false,
    })
    expect(state.pulled).toBe(2)
  })

  it('上限为 0 时一块都不读', async () => {
    const { source, state } = probedSource(utf8Chunks('anything'))

    await expect(readCappedStop(source, 0)).resolves.toEqual({ text: '', truncated: true })
    expect(state.pulled).toBe(0)
  })
})

describe('readCappedDrain', () => {
  it('读到 EOF 但只保留上限内的部分', async () => {
    // stderr 这类管道必须排空：不读完，写端会在管道缓冲写满时阻塞，子进程就此挂住。
    const chunks = utf8Chunks(...Array.from({ length: 1000 }, () => 'y'.repeat(100)))
    const { source, state } = probedSource(chunks)

    const result = await readCappedDrain(source, 250)

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('y'.repeat(250))
    // 与 stop 的唯一差别：这里一直读到底，只是超出上限的部分读了就扔。
    expect(state.pulled).toBe(1000)
  })

  it('流在上限内结束时给出完整文本且不算截断', async () => {
    const { source } = probedSource(utf8Chunks('one ', 'two'))

    await expect(readCappedDrain(source, 100)).resolves.toEqual({
      text: 'one two',
      truncated: false,
    })
  })
})

describe('解码与计数口径', () => {
  it('多字节字符被块边界劈开时仍解成原字符', async () => {
    // 「汉」= E6 B1 89。逐块 Buffer.toString('utf8') 会把两半各自变成替换字符，
    // 而 8 KiB 的块边界落在一个汉字中间是中文输出的常态。
    const bytes = new TextEncoder().encode('汉字')
    const head = bytes.subarray(0, 1)
    const tail = bytes.subarray(1)
    const { source } = probedSource([head, tail])

    await expect(readCappedDrain(source, 100)).resolves.toEqual({
      text: '汉字',
      truncated: false,
    })
  })

  it('上限按 Unicode 码点算，不按 UTF-16 码元', async () => {
    // 一个 emoji 是 1 个码点、2 个 UTF-16 码元。用 .length 当上限会让同一份输出在 Rust 与
    // Node 下截在不同位置，而这种差异只在含 emoji/生僻字时才现形。
    const { source } = probedSource(utf8Chunks('😀'.repeat(10)))

    const result = await readCappedDrain(source, 3)

    expect(result).toEqual({ text: '😀'.repeat(3), truncated: true })
    expect(result.text.length).toBe(6)
  })

  it('截断绝不把代理对切成半个字符', async () => {
    const { source } = probedSource(utf8Chunks('a😀b'))

    const result = await readCappedStop(source, 2)

    expect(result.text).toBe('a😀')
    expect(result.truncated).toBe(true)
  })
})
