import { describe, expect, it } from 'vitest'
import { createServerSseParser, type ServerSseEvent } from './serverSseParser'

function collect(): {
  feed: (chunk: string) => void
  events: ServerSseEvent[]
  comments: string[]
} {
  const events: ServerSseEvent[] = []
  const comments: string[] = []
  const feed = createServerSseParser({
    onEvent: (event) => { events.push(event) },
    onComment: (text) => { comments.push(text) },
  })
  return { feed, events, comments }
}

/** 把一段文本按固定宽度切碎，模拟 TCP 任意切分。 */
function feedInChunks(feed: (chunk: string) => void, text: string, width: number): void {
  for (let index = 0; index < text.length; index += width) {
    feed(text.slice(index, index + width))
  }
}

describe('createServerSseParser', () => {
  it('解析一帧完整事件，event 与 data 各归各位', () => {
    const { feed, events, comments } = collect()
    feed('event: mcp-stdio-close\ndata: {"serverId":"a"}\n\n')
    expect(events).toEqual([{ event: 'mcp-stdio-close', data: '{"serverId":"a"}' }])
    expect(comments).toEqual([])
  })

  it('注释行只进 onComment，不构成事件', () => {
    const { feed, events, comments } = collect()
    feed(': connected\n: heartbeat\n')
    expect(comments).toEqual(['connected', 'heartbeat'])
    expect(events).toEqual([])
  })

  it('【坑一】一帧被切成一字节一块仍解析得出来', () => {
    const { feed, events } = collect()
    feedInChunks(feed, 'event: mcp-stdio-tools-changed\ndata: {"serverId":"本地"}\n\n', 1)
    expect(events).toEqual([
      { event: 'mcp-stdio-tools-changed', data: '{"serverId":"本地"}' },
    ])
  })

  it('【坑二】跨块的 CRLF 不能算成两个换行', () => {
    const { feed, events } = collect()
    // `\r` 落在第一块末尾、`\n` 在第二块开头。当成两个换行的话，中间会多出一个空行，
    // 于是这一帧在 data 行之前就被派发（data 为空 → 什么都不产出），事件整条丢失。
    feed('event: mcp-stdio-close\r')
    feed('\ndata: {"serverId":"a"}\r\n\r\n')
    expect(events).toEqual([{ event: 'mcp-stdio-close', data: '{"serverId":"a"}' }])
  })

  it('【坑三】一行里只有第一个冒号是分隔符，JSON 正文里的冒号原样保留', () => {
    const { feed, events } = collect()
    feed('event: mcp-stdio-close\ndata: {"message":"exited: code 1","serverId":"a"}\n\n')
    expect(events[0]?.data).toBe('{"message":"exited: code 1","serverId":"a"}')
  })

  it('多条 data 行按 \\n 拼回来', () => {
    const { feed, events } = collect()
    feed('event: mcp-stdio-close\ndata: 第一行\ndata: 第二行\n\n')
    expect(events[0]?.data).toBe('第一行\n第二行')
  })

  it('只去掉冒号后的第一个空格，第二个空格属于正文', () => {
    const { feed, events, comments } = collect()
    feed('event: x\ndata:  两个空格\n\n')
    feed(':  两个空格\n')
    expect(events[0]?.data).toBe(' 两个空格')
    expect(comments).toEqual([' 两个空格'])
  })

  it('未完成的帧留在缓冲里，不提前派发', () => {
    const { feed, events } = collect()
    feed('event: mcp-stdio-close\ndata: {"serverId":"a"}\n')
    expect(events).toEqual([])
    feed('\n')
    expect(events).toHaveLength(1)
  })

  it('两帧连着来时各自独立，前一帧的 event 名不会漏给后一帧', () => {
    const { feed, events } = collect()
    feed('event: mcp-stdio-close\ndata: 1\n\ndata: 2\n\n')
    expect(events).toEqual([
      { event: 'mcp-stdio-close', data: '1' },
      { event: '', data: '2' },
    ])
  })

  it('忽略 id / retry / 未知字段', () => {
    const { feed, events } = collect()
    feed('id: 7\nretry: 100\nfoo: bar\nevent: mcp-stdio-close\ndata: 1\n\n')
    expect(events).toEqual([{ event: 'mcp-stdio-close', data: '1' }])
  })
})
