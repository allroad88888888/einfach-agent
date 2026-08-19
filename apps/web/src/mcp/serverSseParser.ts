// 增量 SSE 解析：任意切分的文本块 → 一帧一帧的事件 / 注释行。
// ---------------------------------------------------------------------------
// **这是 `apps/server/src/eventsRoute.testHarness.ts` 里 `createSseParser` 的照抄件**，不是
// 另一份实现。C3 交回时点名把那段当作 C4 的参考实现，并说明**不能 import**：`apps/web` 与
// `apps/server` 是两个 app，app 对 app 的依赖方向不成立（同 `host/serverInvoke.ts` 不 import
// `apps/server` 的 `INVOKE_ROUTE_PREFIX`、只在本地声明一份的理由）。照抄的代价是两份要一起改，
// 换来的是前端产物里不会因为一个解析器把整台 Node server 拖进模块图。
//
// 【本文件只做「字节流 → 帧」这一件事】谁去发请求、断了怎么重连、事件名认不认识，全在
// `serverHostEventStream.ts`。分开的直接好处是这三个坑可以脱离网络被逐字节钉住：
//
//   · **跨块的半行必须留在缓冲里**——一帧被 TCP 切开时，前半行不能当成一整行解析。
//   · **跨块的 `\r\n` 不能当成两个换行**——那会凭空多出一个空行，等于提前派发一帧，
//     后面的内容全部错位成下一帧的开头。
//   · **一行里第一个冒号才是分隔符**——`data:` 的正文是 JSON，里面全是冒号。
//
// 与规范的一处有意偏离（同 C3 的参考实现）：规范里「data 缓冲为空时不派发」，于是一条
// `data:`（空值）什么也不产出。这里只要见过至少一条 `data:` 行就派发。本端点的载荷是非空
// JSON 对象，正常路径上两者等价；差异只出现在「服务端发了一帧空载荷」这种 bug 上，
// 而那时我们要的是看见它，不是吞掉它。

export interface ServerSseEvent {
  /** `event:` 字段。收端读回来的是 `string`，判它是不是真事件名是调用方的事。 */
  readonly event: string
  /** 多条 `data:` 行按 `\n` 拼回来的结果。 */
  readonly data: string
}

export interface ServerSseParserHandlers {
  onEvent(event: ServerSseEvent): void
  /** 注释行（`:` 开头）：心跳与握手提示。规范要求收端忽略，这里只用于「流还活着」的观察。 */
  onComment(text: string): void
}

/** 规范认这三种行分隔符，发端只产 `\n`，收端三种都得认。 */
const SSE_LINE_BREAK = /\r\n|\r|\n/

/** 规范：字段值里紧跟冒号的那**一个**空格属于分隔符，要去掉；第二个空格是正文。 */
function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value
}

export function createServerSseParser(
  handlers: ServerSseParserHandlers,
): (chunk: string) => void {
  let buffer = ''
  let eventType = ''
  let dataLines: string[] = []

  return (chunk: string) => {
    buffer += chunk
    for (;;) {
      const match = SSE_LINE_BREAK.exec(buffer)
      if (match === null) break
      // 缓冲正好停在一个孤零零的 `\r` 上：它可能是被切开的 `\r\n` 的前半个，等下一块再说。
      if (match[0] === '\r' && match.index + 1 === buffer.length) break
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)

      if (line === '') {
        if (dataLines.length > 0) {
          handlers.onEvent({ event: eventType, data: dataLines.join('\n') })
        }
        eventType = ''
        dataLines = []
        continue
      }
      if (line.startsWith(':')) {
        handlers.onComment(stripOneLeadingSpace(line.slice(1)))
        continue
      }
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? '' : stripOneLeadingSpace(line.slice(colon + 1))
      if (field === 'event') eventType = value
      else if (field === 'data') dataLines.push(value)
      // 其余字段（`id` / `retry` / 未知）规范要求忽略——C3 的端点本来也不发，
      // 理由见 `apps/server/src/eventsRouteFrame.ts` 的「刻意不发的两个字段」。
    }
  }
}
