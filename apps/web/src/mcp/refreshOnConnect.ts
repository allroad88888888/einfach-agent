// 连接成功后刷新工具名清单缓存（B3）：manager 每 emit 一次快照就过一眼，把【正连着】的
// 服务的真实工具清单收进缓存。
//
// 【为什么光有安装探测不够】安装即探测（probeOnInstall.ts）只在添加服务那一刻跑一次。
// 服务连上之后工具集还会变——MCP 协议里有 tools/list_changed 通知就是为此，manager 收到
// 后会重新对账并再 emit 一份 connected 快照。不接这一刀，缓存只会越来越旧，而它正是模型
// 在服务【未连接时】判断「值不值得连」的唯一依据。
//
// 【什么时候才真的落盘】订阅是高频回调：连接过程中的 connecting/connected、退避重连、
// 断开、乃至别的服务的任何变化，都会把全量快照数组重放一遍。所以判据不是「收到就写」，
// 而是只认两种【事件】：
//   1. 某个服务从「不是 connected」变成 connected —— 一次正常连接成功，顺带刷新 cachedAt；
//   2. 它保持 connected 但工具清单变了 —— tools/list_changed 对账后的结果。
// 其余快照（同一份 connected 被重放、connecting、reconnecting、error、disconnected）一律
// 不落盘。判据只看每个服务上次落盘时的工具指纹，不看时间，因此不需要时钟，也不会抖动。
//
// 【断开一律不动缓存】这是整个按需模式的前提：未连接时模型靠「上次已知」决定要不要连。
// 断开、连接失败、退避重连都走不到写入分支，更不会清空缓存——尤其是 F6 引入的「只登记未
// 连接」记录（status 'disconnected' + 空工具表），它说的是「现在没连着」，绝不是「这个
// 服务没有工具」，拿它去覆盖缓存等于把已知清单擦成空。
//
// 本文件不 import 任何 atom / store，也不碰磁盘：写入走注入的 McpToolNameCacheWrite，
// 与安装探测共用同一个写入点（toolNameCacheWriter.ts）。

import type { McpServerSnapshot, McpToolSnapshot } from '@web-agent/tools-mcp'
import { toCachedTools, type McpToolNameCacheWrite } from './toolNameCacheWriter'

export interface McpConnectedCacheRefreshContext {
  /** 与安装探测共用的缓存写入点；它自带串行队列，这里只管什么时候调。 */
  readonly write: McpToolNameCacheWrite
  /** service 已 dispose，或这个服务已不在配置里时返回 false。 */
  shouldRefresh(serverId: string): boolean
}

export interface McpConnectedCacheRefresher {
  /**
   * 过一遍 manager 的全量快照。返回的 Promise 在这一轮触发的写入落盘后 resolve；
   * 订阅回调【不等它】——落盘慢不该拖住界面上的状态刷新，等它的只有测试。
   */
  observe(snapshots: readonly McpServerSnapshot[]): Promise<void>
}

/** 工具清单的指纹：名字与描述都会进缓存，任一变化都值得重写一次。 */
function toolsFingerprint(tools: readonly McpToolSnapshot[]): string {
  return JSON.stringify(tools.map((tool) => [tool.name, tool.description]))
}

export function createMcpConnectedCacheRefresher(
  context: McpConnectedCacheRefreshContext,
): McpConnectedCacheRefresher {
  const { write, shouldRefresh } = context
  /** serverId → 该服务【当前这条连接】上次落盘的工具指纹；不在表里就代表「现在没连着」。 */
  const writtenWhileConnected = new Map<string, string>()

  return {
    observe(snapshots) {
      const pending: Promise<void>[] = []
      const present = new Set<string>()
      for (const snapshot of snapshots) {
        present.add(snapshot.id)
        if (snapshot.status !== 'connected') {
          // 断开、失败、退避重连：只忘掉「连着的时候写过什么」，缓存本身原样留着。
          // 忘掉这一步是必要的——下次连上要算作一次新的连接成功，即使工具清单一模一样，
          // 也该把 cachedAt 刷新到那一刻。
          writtenWhileConnected.delete(snapshot.id)
          continue
        }
        if (!shouldRefresh(snapshot.id)) continue
        const fingerprint = toolsFingerprint(snapshot.tools)
        if (writtenWhileConnected.get(snapshot.id) === fingerprint) continue
        // 先记下再落盘：写入要过 IPC，这期间同一份 connected 快照会被重放很多次，
        // 等写完再记就会给同一件事排出一串重复的写入。
        writtenWhileConnected.set(snapshot.id, fingerprint)
        pending.push(write(snapshot.id, {
          tools: toCachedTools(snapshot.tools),
          probeStatus: 'success',
        }))
      }
      // 服务被删除后就不再出现在快照里；把它的指纹一并丢掉，免得这张表随进程一直长，
      // 也让「删掉之后又用同一个 id 加回来」被当成一次全新的连接。
      for (const serverId of [...writtenWhileConnected.keys()]) {
        if (!present.has(serverId)) writtenWhileConnected.delete(serverId)
      }
      if (pending.length === 0) return Promise.resolve()
      return Promise.all(pending).then(() => undefined)
    },
  }
}
