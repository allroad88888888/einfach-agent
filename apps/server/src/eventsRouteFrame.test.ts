import { describe, expect, it } from 'vitest'
import { createSseParser, type SseEvent } from './eventsRoute.testHarness'
import { encodeSseComment, encodeSseFrame, EVENT_STREAM_CONTENT_TYPE } from './eventsRouteFrame'

/** 把一段线上文本喂给解析器，收下解析出的事件与注释。 */
function parse(wire: string, chunkSize = wire.length): { events: SseEvent[]; comments: string[] } {
  const events: SseEvent[] = []
  const comments: string[] = []
  const feed = createSseParser({
    onEvent: (event) => { events.push(event) },
    onComment: (text) => { comments.push(text) },
  })
  for (let offset = 0; offset < wire.length; offset += chunkSize) {
    feed(wire.slice(offset, offset + chunkSize))
  }
  return { events, comments }
}

describe('encodeSseFrame', () => {
  it('单行载荷编成 event / data / 空行三段', () => {
    expect(encodeSseFrame('mcp-stdio-close', '{"a":1}')).toBe(
      'event: mcp-stdio-close\ndata: {"a":1}\n\n',
    )
  })

  it('content-type 是 text/event-stream', () => {
    expect(EVENT_STREAM_CONTENT_TYPE.startsWith('text/event-stream')).toBe(true)
  })

  // ── 换行：本文件存在的主要理由 ──────────────────────────────────────────
  // 今天 `JSON.stringify(payload)` 不产出裸换行，所以这条分支在生产路径上恒不发生。
  // 直接喂多行文本把它逼出来——否则「有人给 stringify 加了 null, 2」就会静默坏掉。

  it('多行载荷拆成多条 data 行，收端拼回原文', () => {
    const wire = encodeSseFrame('mcp-stdio-close', '{\n  "a": 1\n}')
    expect(wire).toBe('event: mcp-stdio-close\ndata: {\ndata:   "a": 1\ndata: }\n\n')
    const { events } = parse(wire)
    expect(events).toEqual([{ event: 'mcp-stdio-close', data: '{\n  "a": 1\n}' }])
  })

  it('CR 与 CRLF 也算换行，且往返后统一成 \\n', () => {
    // 规范只认「行」，不区分原来是哪种分隔符；收端把多条 data 用 \n 拼回来。
    const { events } = parse(encodeSseFrame('mcp-stdio-close', 'a\r\nb\rc\nd'))
    expect(events).toEqual([{ event: 'mcp-stdio-close', data: 'a\nb\nc\nd' }])
  })

  it('载荷里塞一整帧也造不出第二个事件', () => {
    // 注入尝试：正文里带空行 + 一条伪造的 event 行。拆行之后每一行都成了 data 的内容。
    const attack = 'x\n\nevent: mcp-stdio-tools-changed\ndata: {"forged":true}\n\n'
    const { events } = parse(encodeSseFrame('mcp-stdio-close', attack))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ event: 'mcp-stdio-close', data: attack })
  })

  it('空载荷仍产出一条 data 行，收端得到空串', () => {
    expect(encodeSseFrame('mcp-stdio-close', '')).toBe('event: mcp-stdio-close\ndata: \n\n')
    expect(parse(encodeSseFrame('mcp-stdio-close', '')).events).toEqual([
      { event: 'mcp-stdio-close', data: '' },
    ])
  })

  it('正文里的冒号不被当成字段分隔符', () => {
    const data = '{"message":"a: b: c"}'
    expect(parse(encodeSseFrame('mcp-stdio-close', data)).events[0]?.data).toBe(data)
  })

  it('正文开头的空格不会被吃掉（分隔符只吃一个）', () => {
    // 编码器写的是 `data: ` + 正文，正文若以空格开头，收端只该剥掉分隔符那一个。
    expect(parse(encodeSseFrame('mcp-stdio-close', '  两个空格')).events[0]?.data).toBe('  两个空格')
  })

  it('线上文本被任意切块也解析得出同一帧', () => {
    // TCP 不保证按帧切。逐字节喂是最狠的切法。
    const wire = encodeSseFrame('mcp-stdio-close', '{"m":"多\n行 🎈"}')
    expect(parse(wire, 1).events).toEqual(parse(wire).events)
    expect(parse(wire, 1).events[0]?.data).toBe('{"m":"多\n行 🎈"}')
  })

  it('刻意不发 id: 与 retry:', () => {
    // 两者只对 EventSource 的内建重连有意义，而本端点不做重放（理由见 eventsRoute.ts 文件头）。
    const wire = encodeSseFrame('mcp-stdio-close', '{"a":1}')
    expect(wire).not.toMatch(/^id:/m)
    expect(wire).not.toMatch(/^retry:/m)
  })
})

describe('encodeSseComment', () => {
  it('以冒号开头，末尾不补空行', () => {
    expect(encodeSseComment('heartbeat')).toBe(': heartbeat\n')
  })

  it('解析成注释而不是事件', () => {
    const { events, comments } = parse(encodeSseComment('heartbeat'))
    expect(events).toEqual([])
    expect(comments).toEqual(['heartbeat'])
  })

  it('注释正文里的换行同样逐行加冒号，造不出事件', () => {
    const wire = encodeSseComment('a\nevent: mcp-stdio-close\ndata: {}\n')
    expect(wire).toBe(': a\n: event: mcp-stdio-close\n: data: {}\n: \n')
    const { events, comments } = parse(wire)
    expect(events).toEqual([])
    expect(comments).toEqual(['a', 'event: mcp-stdio-close', 'data: {}', ''])
  })

  it('注释穿插在事件之间不影响事件解析', () => {
    const wire = [
      encodeSseComment('connected'),
      encodeSseFrame('mcp-stdio-tools-changed', '{"a":1}'),
      encodeSseComment('heartbeat'),
      encodeSseFrame('mcp-stdio-close', '{"b":2}'),
    ].join('')
    const { events, comments } = parse(wire, 3)
    expect(events).toEqual([
      { event: 'mcp-stdio-tools-changed', data: '{"a":1}' },
      { event: 'mcp-stdio-close', data: '{"b":2}' },
    ])
    expect(comments).toEqual(['connected', 'heartbeat'])
  })
})
