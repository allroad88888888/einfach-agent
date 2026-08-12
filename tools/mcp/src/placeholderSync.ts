// tools/mcp/src/placeholderSync.ts —— 占位工具的【生命周期】：什么时候该在、什么时候该走。
//
// 【为什么和 placeholderTool.ts 分开】那边是纯形状（同样的入参得到同样的 Tool），这边全是
// 副作用（写 ToolRegistry、写占位登记表、挂订阅）。合成一个文件就没有一个能单独断言
// 「desired 规则算对了」的单元，也没法单独断言「占位从不覆盖真实工具」。塞进 clientManager.ts
// 更不行：那是连接状态机，占位恰恰是【没有连接】时才存在的东西。
//
// 【唯一的规则】注册与注销不散落在各处，全部由一条式子决定：
//
//   desired(serverId) = 该服务在 manager 登记表里 且 status !== 'connected'
//                       ? 缓存里该服务的工具名集合
//                       : ∅
//
// 于是「服务一旦 connected，占位集合恒为空」，而断开、失败、退避重连期间占位会回来——
// 「现在没连着」绝不是「这个服务没有工具」，与缓存的既有语义一致。
//
// 【四个重算时机】manager 状态变化（本文件自己 subscribe）、缓存写入或删除之后、hydrate 完成、
// 服务被删除。后三个由宿主在接线处调 sync()；服务删除同时也会让 manager emit 一次，
// 于是「登记表里没有 → desired = ∅」这条也走同一条订阅路径，不需要额外的删除事件。
//
// 【为什么只吃一个 (serverId) => 清单 的只读函数】缓存住在 app 层（要落磁盘、要和设置面板共用
// 同一份数据），依赖方向是 tools-* ← app。本域不认识磁盘，只认这个函数签名，形状与既有的
// lastKnownTools 探针一致。

import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import type { Tool } from '@web-agent/core/tools/types'
import type { McpClientManager } from './clientManager'
import type {
  McpLastKnownToolEntry,
  McpLastKnownToolList,
} from './connect-mcp-server/lastKnownTools'
import type { McpPlaceholderClaims } from './placeholderClaims'
import { createMcpPlaceholderTool } from './placeholderTool'
import { runtimeFor } from './serverConfig'
import type { McpServerSnapshot } from './types'

/** 宿主注入的只读读出口：一个服务【上次已知】的工具清单；没探测过返回 undefined。 */
export type McpPlaceholderToolsProbe = (
  serverId: string,
) => McpLastKnownToolList | undefined

export type McpPlaceholderSkipReason =
  /** 这个名字已被别的注册占着（真实工具，或先到先得的另一个服务的占位）。 */
  | 'name_taken'
  /** registry 里没人占，登记表却说这个名字归别的服务——账实不符，本次跳过。 */
  | 'claim_conflict'

export interface McpPlaceholderSkip {
  readonly serverId: string
  readonly name: string
  readonly reason: McpPlaceholderSkipReason
}

export interface CreateMcpPlaceholderSyncOptions {
  registry: ToolRegistry
  /** 登记表与状态变化的来源。只用到这两个读面，不给同步器任何连接能力。 */
  manager: Pick<McpClientManager, 'list' | 'subscribe'>
  /** 与 manager 的 reconcile 路径【同一个实例】，否则连接时真实工具会被判成工具名冲突。 */
  claims: McpPlaceholderClaims
  lastKnownTools: McpPlaceholderToolsProbe
  /** 撞名跳过时的留痕出口。不接就是静默——所以宿主该接一个，见 app 侧接线。 */
  onSkip?(skip: McpPlaceholderSkip): void
}

export interface McpPlaceholderSync {
  /** 立刻按 desired 规则重算全部服务的占位集合。幂等：没有变化时一次注册都不发生。 */
  sync(): void
  /** 退订 manager；已注册的占位【不】在这里清除（宿主换 core 时由新的同步器接管）。 */
  dispose(): void
}

/** 缓存里拿不出「成功探测到的清单」时一律没有占位——探测失败与空清单都不等于「有工具」。 */
function toDesired(
  list: McpLastKnownToolList | undefined,
): Map<string, McpLastKnownToolEntry> {
  const desired = new Map<string, McpLastKnownToolEntry>()
  if (!list || list.probeStatus !== 'success' || !Array.isArray(list.tools)) return desired
  for (const entry of list.tools) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue
    // 同名条目取第一条：缓存是外部数据，重复名字不该让后面的覆盖前面的。
    if (!desired.has(entry.name)) desired.set(entry.name, entry)
  }
  return desired
}

/** 占位形状只由这两样决定（guide 只依赖 serverId + 名字，都是固定的）。 */
function sameShape(tool: Tool, description: string, runtime: string): boolean {
  return tool.skill.description === description && tool.runtime === runtime
}

export function createMcpPlaceholderSync({
  registry,
  manager,
  claims,
  lastKnownTools,
  onSkip,
}: CreateMcpPlaceholderSyncOptions): McpPlaceholderSync {
  if (!registry || !manager || !claims || typeof lastKnownTools !== 'function') {
    throw new Error('createMcpPlaceholderSync requires registry, manager, claims and lastKnownTools')
  }

  /**
   * 本同步器手上还有占位的服务。
   *
   * 只用来回答「哪些服务即使已经从 manager 登记表里消失，也还要走一遍 desired = ∅」——
   * 占位的账本仍然只有 claims 一本，这里不复制它。
   */
  const servedServers = new Set<string>()

  const report = (serverId: string, name: string, reason: McpPlaceholderSkipReason): void => {
    try {
      onSkip?.({ serverId, name, reason })
    } catch {
      // 留痕出口是观察者，坏掉不能反过来打断占位同步。
    }
  }

  /** 注销本服务占着、但已不在 desired 里的名字。 */
  const releaseUnwanted = (serverId: string, desired: ReadonlySet<string>): void => {
    for (const name of claims.namesFor(serverId)) {
      if (desired.has(name)) continue
      const tool = claims.get(name)?.tool
      if (!tool) continue
      // 一律 expected 形式：真实工具若已把这个名字接管过去，这次注销必然落空，不可能误伤它。
      registry.unregister(name, tool)
      claims.release(name, tool)
    }
  }

  /** 把 desired 里还没登记的名字注册成占位。 */
  const registerWanted = (
    server: McpServerSnapshot,
    desired: ReadonlyMap<string, McpLastKnownToolEntry>,
    cachedAt: number,
  ): void => {
    const serverId = server.id
    const runtime = runtimeFor(server.config)
    for (const [name, entry] of desired) {
      const claim = claims.get(name)
      const mine = claim?.serverId === serverId ? claim.tool : undefined
      const holdsMine = mine !== undefined && registry.has(name, mine)
      // 每次都造新实例：registry 与登记表的 expected 校验全按实例比对，共享实例会让
      // 「谁占着这个名字」失去分辨力。形状没变时下面会原样丢弃它，不产生任何注册。
      const placeholder = createMcpPlaceholderTool({ serverId, entry, runtime, cachedAt })

      if (holdsMine && sameShape(mine, placeholder.skill.description, runtime)) continue
      if (holdsMine) {
        // 缓存刷新过，占位形状变了：先摘再挂，expected 形式保证只动自己那一份。
        registry.unregister(name, mine)
        claims.release(name, mine)
      } else if (mine) {
        // 登记说是本服务的，registry 里却已经不是它了（正常路径下 reconcile 会释放，
        // 这里是纵深防御）：先把账清掉，再按下面的规则重新判一次。
        claims.release(name, mine)
      }

      // 真实工具永远优先，跨服务撞名先到先得：registry 里已经有人 → 跳过，绝不覆盖。
      if (registry.has(name)) {
        // 被【真实工具】占着是正常状态（连接过程中 reconcile 刚覆盖完就是这样），留痕只会刷屏；
        // 被【另一个服务的占位】占着才是蓝图要的那条诊断：先到先得，后者跳过，但不静默。
        const holder = claims.get(name)
        if (holder && holder.serverId !== serverId) report(serverId, name, 'name_taken')
        continue
      }
      registry.register(placeholder)
      if (!claims.claim(serverId, name, placeholder)) {
        // 登记表说这个名字归别人，registry 里却是空的：不留一个没有账的注册。
        registry.unregister(name, placeholder)
        report(serverId, name, 'claim_conflict')
      }
    }
  }

  const sync = (): void => {
    const servers = new Map<string, McpServerSnapshot>()
    for (const server of manager.list() ?? []) {
      if (server && typeof server.id === 'string' && server.id) servers.set(server.id, server)
    }

    // 登记表里没有、但本同步器还占着名字的服务也要走一遍：它们的 desired 就是 ∅。
    for (const serverId of new Set([...servedServers, ...servers.keys()])) {
      const server = servers.get(serverId)
      let desired = new Map<string, McpLastKnownToolEntry>()
      let cachedAt = 0

      if (server && server.status !== 'connected') {
        let list: McpLastKnownToolList | undefined
        try {
          list = lastKnownTools(serverId)
        } catch {
          // 宿主探针抛错 = 这一轮答不上来。此时【不动】这个服务的占位：
          // 把「问不到」当成「没有工具」会在一次读盘失败里把整份清单从模型眼前抹掉。
          continue
        }
        desired = toDesired(list)
        cachedAt = typeof list?.cachedAt === 'number' ? list.cachedAt : 0
      }

      releaseUnwanted(serverId, new Set(desired.keys()))
      if (server && desired.size > 0) registerWanted(server, desired, cachedAt)

      if (claims.namesFor(serverId).length > 0) servedServers.add(serverId)
      else servedServers.delete(serverId)
    }
  }

  // 时机一：manager 状态变化。登记、连接、断开、失败、删除都会 emit，占位因此自己跟着走。
  const unsubscribe = manager.subscribe(() => sync())
  // 装配当刻先对一次账：此时缓存可能还没读盘（那就什么都不注册），hydrate 完成后宿主会再调一次。
  sync()

  return {
    sync,
    dispose() {
      unsubscribe()
    },
  }
}
