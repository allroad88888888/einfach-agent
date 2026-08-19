import { describe, expect, it } from 'vitest'
import { JsonRpcLineFramer, type ProtocolFrame } from './frames'
import { MAX_PROTOCOL_LINE_BYTES } from './limits'

function texts(frames: readonly ProtocolFrame[]): string[] {
  return frames.map((frame) => (frame.kind === 'line' ? frame.bytes.toString('utf8') : '<oversized>'))
}

function pushText(framer: JsonRpcLineFramer, text: string): string[] {
  return texts(framer.push(Buffer.from(text, 'utf8')))
}

describe('行帧切分', () => {
  it('一个 chunk 一条完整行', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"id":1}\n')).toEqual(['{"id":1}'])
  })

  // ── 半包：一条帧被拆成多个 chunk ──────────────────────────────────────────
  it('一条帧被拆成多个 chunk 时，只有收齐才吐出来', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"jsonrpc":"2.0",')).toEqual([])
    expect(pushText(framer, '"id":7,')).toEqual([])
    expect(pushText(framer, '"result":{}}')).toEqual([])
    expect(pushText(framer, '\n')).toEqual(['{"jsonrpc":"2.0","id":7,"result":{}}'])
  })

  it('换行单独成一个 chunk 也能收口', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, 'a')).toEqual([])
    expect(pushText(framer, '\n')).toEqual(['a'])
  })

  // ── 粘包：多条帧挤在一个 chunk 里 ─────────────────────────────────────────
  it('一个 chunk 里的多条帧全部吐出，一条不漏', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"a":1}\n{"b":2}\n{"c":3}\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ])
  })

  it('粘包与半包混在同一个 chunk：两条完整 + 半条', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"a":1}\n{"b":2}\n{"c":')).toEqual(['{"a":1}', '{"b":2}'])
    expect(pushText(framer, '3}\n{"d":4}\n')).toEqual(['{"c":3}', '{"d":4}'])
  })

  // ── UTF-8 多字节被 chunk 边界劈开 ─────────────────────────────────────────
  it('多字节字符被 chunk 边界劈开时仍然解出原字符', () => {
    const framer = new JsonRpcLineFramer()
    const payload = Buffer.from('{"text":"第一页 🌐 café"}\n', 'utf8')
    const collected: ProtocolFrame[] = []
    // 逐字节喂：每个汉字 3 字节、emoji 4 字节，切点必然落在字符中间。
    for (const byte of payload) collected.push(...framer.push(Buffer.from([byte])))
    expect(texts(collected)).toEqual(['{"text":"第一页 🌐 café"}'])
  })

  it('切在多字节字符正中间的两个 chunk 拼回原字符', () => {
    const framer = new JsonRpcLineFramer()
    const line = Buffer.from('{"t":"漢"}\n', 'utf8')
    const splitAt = line.indexOf(0xe6) + 1 // 「漢」的首字节之后
    expect(texts(framer.push(line.subarray(0, splitAt)))).toEqual([])
    expect(texts(framer.push(line.subarray(splitAt)))).toEqual(['{"t":"漢"}'])
  })

  // ── 行尾与边角 ───────────────────────────────────────────────────────────
  it('CRLF 行尾的 \\r 一并剥掉', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"a":1}\r\n')).toEqual(['{"a":1}'])
  })

  it('空行吐出一条空帧（由调用方的 JSON 解析去拒）', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '\n\n')).toEqual(['', ''])
  })

  it('EOF 时没有行尾换行的最后一行仍是一条帧', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"a":1}\n{"b":2}')).toEqual(['{"a":1}'])
    expect(texts(framer.end())).toEqual(['{"b":2}'])
  })

  it('EOF 时没有残余则不吐任何帧', () => {
    const framer = new JsonRpcLineFramer()
    expect(pushText(framer, '{"a":1}\n')).toEqual(['{"a":1}'])
    expect(framer.end()).toEqual([])
  })

  // ── 超大行 ───────────────────────────────────────────────────────────────
  it('超过上限的行整行丢弃，并且**不影响下一行的对齐**', () => {
    const framer = new JsonRpcLineFramer()
    const half = Buffer.alloc(MAX_PROTOCOL_LINE_BYTES / 2 + 1, 0x61)
    expect(framer.push(half)).toEqual([])
    // 第二块把它顶过上限：内容全丢，但仍要吃到行尾才算这一行结束。
    expect(framer.push(half)).toEqual([])
    expect(texts(framer.push(Buffer.from('rest-of-the-huge-line\n{"a":1}\n')))).toEqual([
      '<oversized>',
      '{"a":1}',
    ])
  })

  it('超大行在 EOF 处结束（没有换行）也报 oversized', () => {
    const framer = new JsonRpcLineFramer()
    framer.push(Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 0x61))
    expect(texts(framer.end())).toEqual(['<oversized>'])
  })

  it('恰好等于上限的行仍然通过', () => {
    const framer = new JsonRpcLineFramer()
    // Rust 的判据是 `已攒 + 本段(含换行) <= 上限`，所以内容最多 上限-1 字节。
    const line = Buffer.concat([
      Buffer.alloc(MAX_PROTOCOL_LINE_BYTES - 1, 0x61),
      Buffer.from('\n'),
    ])
    const frames = framer.push(line)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.kind).toBe('line')
  })
})
