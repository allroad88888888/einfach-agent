/**
 * 按 serverId 串行化操作的队列：同一个服务上的连接/断开/删除/对账永远一个接一个跑，
 * 不同服务之间互不排队。
 *
 * 这是整个 MCP 连接状态机赖以成立的前提之一 —— 连接身份的世代检查只有在「检查与改动
 * 之间没有别的操作插进来」时才有意义。从 clientManager.ts 拆出来只是换个住处：
 * 它是一台纯粹的调度机器，不认识连接、记录和工具。
 *
 * 两条语义必须原样保持：
 * - 前一个操作【失败也不阻断】后一个（`previous.catch()`），否则一次连接失败会把这个
 *   服务的队列永久卡死；
 * - 队尾是自己时才清理（引用比较），否则会把后来者的队尾误删，让串行退化成并行。
 */
export class McpServerQueue {
  private readonly tails = new Map<string, Promise<void>>()

  /** 把 operation 排到该服务队尾；返回值就是 operation 自己的结果（含拒绝）。 */
  serialize<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(serverId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(serverId, tail)
    void tail.then(() => {
      if (this.tails.get(serverId) === tail) {
        this.tails.delete(serverId)
      }
    })
    return result
  }
}
