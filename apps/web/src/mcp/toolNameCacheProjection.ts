// 把进程内那份工具名缓存投影到设置面板的 atom 上（B5）。
//
// 【为什么不是 UI 自己去读】UI 只能读 atom，不能持有 service、更不能调 writer；而缓存住在
// toolNameCacheWriter.ts 的闭包里。所以需要一层投影：缓存每次变化（冷启动读盘、安装探测、
// 连接成功刷新）把最新那份推进 atom，UI 那边就只剩「读一个 atom」这一件事。
//
// 【不是第二份快照】推进 atom 的是 handle.read() 交出来的【同一个对象引用】，不是拷贝，
// 也不会被反向写回：atom 是只读投影，缓存的唯一写入路径仍然只有 handle.write。
//
// 【为什么包一层 write 而不是让调用方各自记得推】写入点有两个（probeOnInstall / refreshOnConnect），
// 谁忘了推谁那条路径的界面就停在旧数据上。包在这里，service 把包好的 write 发下去，忘不掉。

import type { Store } from '@einfach/core'
import { mcpLastKnownToolsAtom } from './state'
import type {
  McpToolNameCacheHandle,
  McpToolNameCacheRemove,
  McpToolNameCacheWrite,
} from './toolNameCacheWriter'

export interface McpToolNameCacheProjection {
  /** 写完顺手把最新快照推给界面；签名与 handle.write 完全一致，也同样绝不 reject。 */
  readonly write: McpToolNameCacheWrite
  /**
   * 删完顺手把最新快照推给界面；签名与 handle.remove 完全一致，也同样绝不 reject。
   * 目前唯一的调用点是服务删除时级联清缓存（A2）。
   */
  readonly remove: McpToolNameCacheRemove
  /** 冷启动：把磁盘上的缓存读进快照并推给界面。绝不 reject。 */
  load(): Promise<void>
}

export interface CreateMcpToolNameCacheProjectionOptions {
  store: Store
  cache: McpToolNameCacheHandle
  /** 这个 service 是否还在（dispose 之后不该再动它的 store）。 */
  isActive(): boolean
  /**
   * 「缓存变了」的第二个消费者：占位工具同步器（D2）。
   *
   * 【为什么挂在这里】占位集合是缓存的派生视图，和界面 atom 是同一件事的两个投影：缓存一变
   * 两边都得重算。而 publish 已经是「缓存变了」唯一的汇合点——写入、删除、冷启动读盘三条路
   * 都经过它。挂在这里，新增写入点的人不需要记得同时通知占位；另起一条通知路径才是给
   * 「只更新了一半」留后门。
   *
   * 绝不 reject 的纪律照旧对它成立：它抛错不该把「缓存已经写成功」改写成失败。
   */
  onChange?(): void
}

export function createMcpToolNameCacheProjection({
  store,
  cache,
  isActive,
  onChange,
}: CreateMcpToolNameCacheProjectionOptions): McpToolNameCacheProjection {
  const publish = (): void => {
    if (!isActive()) return
    store.setter(mcpLastKnownToolsAtom, cache.read())
    try {
      onChange?.()
    } catch {
      // 观察者坏掉不能反过来打断缓存写入。
    }
  }

  return {
    write: async (serverId, input) => {
      await cache.write(serverId, input)
      publish()
    },
    remove: async (serverId) => {
      await cache.remove(serverId)
      publish()
    },
    load: async () => {
      await cache.load()
      publish()
    },
  }
}
