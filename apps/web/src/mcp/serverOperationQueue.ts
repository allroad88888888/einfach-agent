/**
 * MCP 服务的【按 serverId 串行】队列：同一个服务上的连接、重连、断开、删除、安装探测
 * 一个接一个跑；不同服务之间照常并行。
 *
 * 从 service.ts 拆出来的理由和 configWriteQueue.ts 相同——它回答的是一个独立问题：同一个
 * 服务上的两条命令怎么不打架（典型的坏结果是重连排在删除后面，把刚删掉的服务又连回来）。
 * 这与表单流程、连接编排、探测进度都无关，service 那边的命令只该说「要做什么」。
 *
 * 【分工】这里只保证「同一个服务的操作不交错」。配置清单和工具名缓存都是全局的一份，
 * 不同服务的两次写入照样会互相覆盖，那一层的读-改-写原子性各由 configWriteQueue.ts 与
 * toolNameCacheWriter.ts 单独负责。
 */
export type McpServerOperationQueue = <T>(
  serverId: string,
  operation: () => Promise<T>,
) => Promise<T>

export function createMcpServerOperationQueue(): McpServerOperationQueue {
  const queues = new Map<string, Promise<void>>()

  return <T>(serverId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(serverId) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(operation)
    const settled = current.then(
      () => undefined,
      () => undefined,
    )
    queues.set(serverId, settled)
    void settled.finally(() => {
      if (queues.get(serverId) === settled) queues.delete(serverId)
    })
    return current
  }
}
