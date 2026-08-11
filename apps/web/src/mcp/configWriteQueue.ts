import type { Store } from '@einfach/core'
import type { McpConfigStorage } from './persistence'
import { mcpServerConfigsAtom } from './state'
import type { PersistedMcpServerConfig } from './types'

/**
 * MCP 服务配置的【原子读-改-写】：把「读 atom → 算出下一份清单 → 落盘 → 回写 atom」
 * 整轮串起来，全进程一条队列。
 *
 * 从 service.ts 拆出来是因为它回答的是一个独立问题——并发写入怎么不丢——与连接编排、
 * 表单流程、探测进度都无关。service 里那几条命令只需要说「配置怎么变」，不该顺带持有
 * 一份并发纪律。
 */

export type McpConfigUpdate = (
  current: readonly PersistedMcpServerConfig[],
) => readonly PersistedMcpServerConfig[]

/** 提交一次配置变更，返回落盘后的完整清单。 */
export type McpConfigPersist = (
  update: McpConfigUpdate,
) => Promise<readonly PersistedMcpServerConfig[]>

export interface CreateMcpConfigWriteQueueOptions {
  store: Store
  storage: McpConfigStorage
}

/**
 * 队列覆盖【全部调用方】（submitDraft、importJson、remove、setAutoConnect），
 * 而不只是 service 里那条按 serverId 的队列。
 *
 * 理由：storage.save() 在 Tauri 实现里要等一次真实 IPC 往返，于是「读 atom」和
 * 「写 atom」之间被劈开一个让出点。两个作用在不同 serverId 上的操作彼此并不互斥，
 * 若各自在调用点先读一次 store.getter()，就会基于同一份过期快照算出两份互相冲突的
 * 「下一份清单」，谁的 save 后完成谁覆盖对方——磁盘和内存一起丢改动。
 *
 * 所以这里收的是【transform 函数】而不是算好的清单：store.getter() 只在轮到自己的
 * 那一轮临界区里读，读-改-写才重新变回原子操作。
 */
export function createMcpConfigWriteQueue({
  store,
  storage,
}: CreateMcpConfigWriteQueueOptions): McpConfigPersist {
  let queue: Promise<void> = Promise.resolve()

  return (update) => {
    let next: readonly PersistedMcpServerConfig[] = []
    const turn = queue.then(async () => {
      next = update(store.getter(mcpServerConfigsAtom))
      await storage.save(next)
      store.setter(mcpServerConfigsAtom, next)
    })
    queue = turn.catch(() => undefined)
    return turn.then(() => next)
  }
}
