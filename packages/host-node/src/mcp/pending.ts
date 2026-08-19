// 在途 JSON-RPC 请求表：id → 「答案来了叫我」
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_support.rs 的 `PendingRequests` 与 mcp_protocol.rs 的
// `fail_pending`。Rust 用 `mpsc::sync_channel(1)` 一请求一条通道，Node 用一个 resolver 回调——
// 同一件事：**响应是从另一条执行流回来的**（Rust 是 reader 线程，Node 是 stdout 的 'data' 回调），
// 发请求的那一头必须能被它唤醒。

/** 对端 JSON-RPC error 对象的三个字段。 */
export interface RpcFailure {
  code: number
  message: string
  data: unknown
}

/**
 * 一次请求的结局。三种，且 `transport` 与 `error` **不能合并**：
 *   · `error` 是对端**回答了**「我办不到」——连接是好的，重试同一个请求多半还是这个结果；
 *   · `transport` 是**没人回答**（管道关了、进程没了、消息超限）——连接坏了，是另一类失败，
 *     tools/mcp 那边据此走重连而不是把错误交给模型。
 */
export type RpcReply =
  | { kind: 'result'; value: unknown }
  | { kind: 'error'; failure: RpcFailure }
  | { kind: 'transport'; message: string }

export type RpcReplyHandler = (reply: RpcReply) => void

export class PendingRequests {
  private readonly entries = new Map<number, RpcReplyHandler>()

  register(id: number, handler: RpcReplyHandler): void {
    this.entries.set(id, handler)
  }

  /** 撤销登记（超时、写失败）。答案后到时就变成一条无主响应，被 dispatch 静默丢弃。 */
  remove(id: number): void {
    this.entries.delete(id)
  }

  /** 投递答案。返回是否真的有人在等——没人等说明这条响应迟到了或对端凭空发的。 */
  settle(id: number, reply: RpcReply): boolean {
    const handler = this.entries.get(id)
    if (handler === undefined) return false
    this.entries.delete(id)
    handler(reply)
    return true
  }

  /**
   * 让**全部**在途请求以同一个理由失败。
   *
   * 先整份摘出来再逐个通知（对齐 Rust 的 `drain()` 再循环）：通知里可能同步走到清理路径、
   * 再次调到本方法，边遍历边删会漏掉一部分，症状是「断线之后有一两个请求永远挂着不返回」。
   */
  failAll(reply: RpcReply): void {
    const handlers = [...this.entries.values()]
    this.entries.clear()
    for (const handler of handlers) handler(reply)
  }
}
