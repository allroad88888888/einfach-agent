// 工具名清单缓存的【进程内那一份】：写入点，以及从同一份快照出的读出口。
//
// 一次写入是「读回整份缓存 → 换掉其中一条 → 整份写回去」，而写回要过一次 Tauri IPC，
// 中间必然让出。两轮交错就会丢掉先写的那条，所以这里和 configWriteQueue.ts 对配置的
// 纪律相同：整轮读-改-写落在一条串行队列里，临界区内除必须的 load/save 不插别的 await
// 点，缓存快照只在临界区内读取。
//
// 【为什么单独成文件】写入时机现在有两个：安装即探测（B2，probeOnInstall.ts）与连接成功
// 后刷新（B3，refreshOnConnect.ts）。上面那条队列和它记住的内存快照是「不丢写入」的全部
// 依据——两边各造一份，就是两条队列各读各的旧快照再互相覆盖。共用同一个 handle 才谈得上
// 原子，所以它必须是两边都拿得到的东西，而不是某一方的私有闭包。
//
// 【读出口为什么也在这里 · B5】读的人有三个：设置面板（未连接服务的「上次可用工具 N 个」）、
// core 的未连接工具探针（B4）、连接工具的 manifest 清单（F4）。给读者另造一份快照就等于
// 造了第二条读-改-写路径，也就等于上面那条纪律没了；所以读出口原样交出【同一个对象引用】，
// 本文件仍然只负责一件事：进程内那一份工具名缓存快照的持有与串行更新。
//
// 缓存写入留在 app 层：tools/mcp 与 packages/agent-core 都不碰磁盘，本文件只经由注入的
// McpToolNameCacheStorage 读写；数据形状与三条上限见 toolNameCache.ts。

import type { McpToolSnapshot } from '@web-agent/tools-mcp'
import {
  setToolNameCacheEntry,
  type McpToolNameCache,
  type SetToolNameCacheEntryInput,
} from './toolNameCache'
import type { McpToolNameCacheStorage } from './toolNameCacheStorage'

/**
 * 写入某个 serverId 的缓存条目。
 *
 * 【绝不 reject】写缓存失败只是少了一份随时可重建的清单，不该把调用方的结论
 * （探测成功、服务已连上）改写成失败，更不该冒泡成一次用户可见的错误。
 */
export type McpToolNameCacheWrite = (
  serverId: string,
  input: SetToolNameCacheEntryInput,
) => Promise<void>

/**
 * 把 manager 的工具快照转成缓存条目。
 *
 * 存 ToolRegistry 名（`mcp__<serverId>__<remoteName>`）而不是远端原名：这份清单是给模型
 * 看的，模型日后真要调用时写的就是这个名字，B4 的「该工具所属服务未连接」提示也按这个
 * 名字匹配。remoteName 只在 adapter 内部用。
 */
export function toCachedTools(
  tools: readonly McpToolSnapshot[],
): SetToolNameCacheEntryInput['tools'] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description }))
}

/** 进程内那一份缓存快照的把手：写入、同步读出、冷启动读盘，共用同一条队列与同一份快照。 */
export interface McpToolNameCacheHandle {
  /** 见 McpToolNameCacheWrite。 */
  readonly write: McpToolNameCacheWrite
  /**
   * 同步读出当前那份快照——B5 两根接线（B4 未连接工具探针、F4 manifest 清单）的取数口。
   *
   * 缓存是不可变值，每次写入换一份新的，所以读者每次都要重新调用；返回的是内部持有的
   * 【同一个对象引用】，不是拷贝。还没读盘也没写过时返回 {}（= 什么都不知道），
   * 绝不因此假装某个服务没有工具。
   */
  read(): McpToolNameCache
  /**
   * 冷启动把磁盘上的缓存读进这份快照。
   *
   * 已经有快照（写过或读过）时原样返回：磁盘上的是旧数据，用它盖掉内存里更新的那份
   * 正是本文件要防的丢写入。走同一条串行队列，因此不会插进某次写入的读-改-写中间。
   * 【绝不 reject】：读不回来只是少一份可重建的清单，冷启动不该因此失败。
   */
  load(): Promise<McpToolNameCache>
}

export function createMcpToolNameCacheHandle(
  storage: McpToolNameCacheStorage,
): McpToolNameCacheHandle {
  let cache: McpToolNameCache | undefined
  let queue: Promise<void> = Promise.resolve()

  const loadCache = async (): Promise<McpToolNameCache> => {
    try {
      return await storage.load()
    } catch {
      // 缓存本来就是可丢弃的（丢了顶多重新探测一次），读不回来就从空开始，
      // 绝不因此让「服务已经保存成功 / 已经连上」这件事看起来失败。
      return {}
    }
  }

  const write: McpToolNameCacheWrite = (serverId, input) => {
    const turn = queue.then(async () => {
      const current = cache ?? await loadCache()
      const next = setToolNameCacheEntry(current, serverId, input)
      await storage.save(next)
      cache = next
    })
    queue = turn.catch(() => undefined)
    return turn.catch(() => undefined)
  }

  return {
    write,
    read: () => cache ?? {},
    load: () => {
      const turn = queue.then(async () => {
        cache ??= await loadCache()
        return cache
      })
      queue = turn.then(() => undefined, () => undefined)
      return turn.catch(() => cache ?? {})
    },
  }
}
