// 往子进程 stdin 写一行 JSON
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_protocol.rs 的 `write_json_line` 与 mcp_support.rs 的
// `SharedWriter`（`Arc<Mutex<Option<ChildStdin>>>`）。那个 `Option` 是关键：会话关闭时把它
// `take()` 掉，于是「stdin 已经关了」是一个可判定的状态，而不是「写下去然后收 EPIPE」。
//
// MCP 的 stdio 帧格式就是**一行一条 JSON**（不是 LSP 那套 `Content-Length` 头），所以写侧只有
// 「序列化 + 换行 + flush」这一件事。

import type { Writable } from 'node:stream'

export class McpStdinWriter {
  private stream: Writable | undefined

  constructor(stream: Writable) {
    this.stream = stream
  }

  get isClosed(): boolean {
    return this.stream === undefined
  }

  /**
   * 写一条消息。
   *
   * **必须等 write 的回调**：Node 的 `write()` 返回的是背压标志，不是「写成功了」，失败经回调
   * （或流的 'error' 事件）才到。不等就把「stdin 已经断了」当成写成功，请求会一直挂到超时——
   * 报出来是 `timeout` 而不是 `transport_error`，而这两者在 tools/mcp 那边是不同的重试策略。
   *
   * 拒绝时的 Error message 与 Rust 侧的 `io::Error` Display **不可能逐字相同**（Node 说
   * `write EPIPE`，Rust 说 `Broken pipe (os error 32)`）——这属于对拍口径里已登记的「OS 错误串」
   * 排除项。唯一由本仓库撰写、因而必须逐字一致的那句是下面的 `MCP stdin is closed`。
   */
  write(value: unknown): Promise<void> {
    const stream = this.stream
    if (stream === undefined) return Promise.reject(new Error('MCP stdin is closed'))
    const line = `${JSON.stringify(value)}\n`
    return new Promise<void>((resolve, reject) => {
      stream.write(line, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * 关掉 stdin。这是**让守规矩的 MCP server 自己退出**的信号——先 end 再等，比一上来就
   * SIGKILL 干净得多（server 有机会 flush 日志、删临时文件）。强杀是 grace 用尽之后的兜底。
   *
   * `end()` 而不是 `destroy()`：destroy 是撕掉 fd，对端读到的是 EPIPE 而不是 EOF。
   */
  close(): void {
    const stream = this.stream
    this.stream = undefined
    if (stream === undefined) return
    try {
      stream.end()
    } catch {
      // 进程已经没了：stdin 本来就该没了，这正是我们要的结果。
    }
  }
}
