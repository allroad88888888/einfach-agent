// JSON-RPC 行帧的切分：把子进程 stdout 的字节块流切成一条条完整的消息
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_protocol.rs 的 `read_protocol_line` / `trim_line_ending`。
//
// ═══ 为什么这件事必须有独立实现，而不是 `data` 事件里 `JSON.parse(chunk)` ═══
// 一次 `data` 事件与一条消息之间**没有任何对应关系**，两个方向都会错：
//   · **半包**——一条 4 KiB 的 tools/list 响应会被管道切成两个 chunk，先到的那半不是合法 JSON；
//   · **粘包**——服务端连着写三条通知，OS 可以把它们合并进一个 chunk，`JSON.parse` 看到
//     `{...}\n{...}\n{...}` 直接抛错，三条全丢。
// 两者都属于「本地测试全绿、接上真实 MCP server 偶发丢消息」那一类：单元测试里 fake server
// 每条消息一次 write、量又小，chunk 边界恰好落在消息边界上，问题一次都不会出现。
//
// ═══ UTF-8 跨 chunk 为什么在这里不需要 StringDecoder ═══
// workspace/common/readCapped.ts 用 `StringDecoder` 解决「多字节字符被块边界劈开」，那是因为它
// 必须**按码点数**封顶，不得不边读边解码。这里不一样：**帧的分隔符是 `\n`（0x0A），而 UTF-8 的
// 多字节序列里每个字节都 ≥ 0x80**，`\n` 不可能出现在一个字符的中间。所以按**字节**找分隔符、
// 攒够一整行再一次性 `toString('utf8')`，多字节字符被劈开是结构上不可能的事，不是「测过没问题」。
// Rust 侧同样是字节切分 + `serde_json::from_slice`。
// （测试里仍有一条汉字跨 chunk 的用例——钉的是这条性质，不是碰运气。）
//
// 本模块是**纯的**：不碰流、不碰进程、不认识 JSON。喂字节、吐帧。

import { MAX_PROTOCOL_LINE_BYTES } from './limits'

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/** 一条完整的行（已去掉行尾 `\r\n` / `\n`），内容尚未解析。 */
export interface ProtocolLineFrame {
  kind: 'line'
  bytes: Buffer
}

/** 一行超过 `MAX_PROTOCOL_LINE_BYTES`，整行已丢弃。调用方据此让在途请求失败。 */
export interface ProtocolOversizedFrame {
  kind: 'oversized'
}

export type ProtocolFrame = ProtocolLineFrame | ProtocolOversizedFrame

/**
 * 行帧切分器。
 *
 * **所有权约定**：`push` 进来的 chunk 交给本对象保管，调用方不得再修改它——切分器保存的是
 * chunk 上的**视图**（`subarray`），复制一份等于给每条 16 MiB 的消息再来一次 16 MiB。
 * Node 的 `Readable` 每次 'data' 都给一份新分配的 Buffer，天然满足。
 */
export class JsonRpcLineFramer {
  /** 当前这一行已收到的片段。攒到 `\n` 才拼。 */
  private segments: Buffer[] = []
  private bufferedBytes = 0
  /**
   * 当前这一行已经超限：内容全丢，但仍要**继续吃到行尾**才能对齐下一条消息。
   * 少了这一步，一条超大消息的后半截会被当成新消息去解析。
   */
  private oversized = false

  /** 喂一块字节，吐出这一块里凑齐的所有帧（可能 0 条，也可能多条）。 */
  push(chunk: Uint8Array): ProtocolFrame[] {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const frames: ProtocolFrame[] = []
    let offset = 0
    while (offset < buffer.length) {
      const newline = buffer.indexOf(NEWLINE, offset)
      // 与 Rust 的 `consumed` 逐字对应：找到换行就连它一起吃掉，没找到就吃到块尾。
      const end = newline === -1 ? buffer.length : newline + 1
      this.absorb(buffer.subarray(offset, end))
      offset = end
      if (newline !== -1) frames.push(this.finishLine())
    }
    return frames
  }

  /**
   * 流结束（EOF）。**没有行尾换行的最后一行仍然是一条消息**——Rust 的
   * `read_protocol_line` 在 `fill_buf` 返回空且 `line` 非空时走的正是 Message 分支。
   * 一个进程被杀在写到一半的服务端，最后那半条本来就不该被当成合法消息，但那由 JSON 解析去拒，
   * 不由分帧器猜。
   */
  end(): ProtocolFrame[] {
    if (this.oversized) return [this.finishLine()]
    if (this.bufferedBytes === 0) return []
    return [this.finishLine()]
  }

  private absorb(segment: Buffer): void {
    if (this.oversized) return
    // 上限判据与 Rust 逐字相同：`已攒 + 本段（含换行符）> 上限` 即翻转。
    // 唯一的差异是「本段」的粒度——Rust 是 BufReader 的 8 KiB 内部缓冲，Node 是管道给的 chunk，
    // 所以在**距离 16 MiB 一个 chunk 以内**的边角上两边可能差一行的判决。这个差异无法消除
    // （块大小不是契约的一部分），也不值得消除：16 MiB 上限挡的是失控的对端，不是精确计量。
    if (this.bufferedBytes + segment.length > MAX_PROTOCOL_LINE_BYTES) {
      this.segments = []
      this.bufferedBytes = 0
      this.oversized = true
      return
    }
    this.segments.push(segment)
    this.bufferedBytes += segment.length
  }

  /** 收尾当前行并复位状态。复位对应 Rust 每次进 `read_protocol_line` 时的 `line.clear()`。 */
  private finishLine(): ProtocolFrame {
    if (this.oversized) {
      this.oversized = false
      return { kind: 'oversized' }
    }
    // 单片段是绝大多数情况（一条消息一次 write），此时连 concat 都不做——`Buffer.concat`
    // 即使只有一个元素也会整份复制。
    const joined = this.segments.length === 1
      ? (this.segments[0] as Buffer)
      : Buffer.concat(this.segments, this.bufferedBytes)
    this.segments = []
    this.bufferedBytes = 0
    return { kind: 'line', bytes: trimLineEnding(joined) }
  }
}

/** 去掉行尾的 `\n`，再去掉它前面的 `\r`。等价 Rust 的 `trim_line_ending`。 */
function trimLineEnding(line: Buffer): Buffer {
  let end = line.length
  if (end > 0 && line[end - 1] === NEWLINE) end -= 1
  if (end > 0 && line[end - 1] === CARRIAGE_RETURN) end -= 1
  return end === line.length ? line : line.subarray(0, end)
}
