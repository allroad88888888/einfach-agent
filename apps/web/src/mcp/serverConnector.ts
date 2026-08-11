// 「一份持久化配置怎么变成 manager 上的一次真实登记 / 连接」，以及这条路上的两道准入判据。
//
// 从 service.ts 拆出来的理由与 runtimeWriters.ts / configWriteQueue.ts 相同：它回答的是
// 一个独立问题——某个配置现在允不允许连、连出来的结果怎么落到运行态——而不关心表单流程、
// 探测进度或者谁在排队。service 那边留下的是编排。
//
// 两道判据都必须在【这里】，因为本文件是设置面板这条路径上唯一直通 manager.connect 的地方：
//   1. 传输能力：浏览器里没有 stdio 连接器，配置可以存但连不了。
//   2. 起进程确认（H2）：stdio 的启动命令必须被用户确认过（mayLaunchMcpServer）。
//      调用方在自己那一层会先拦一次并把确认请求摆给用户，但这里是最后一道——写错一个
//      调用点也不会变成「无人过问地在用户机器上执行一条命令」。

import type { McpClientManager } from '@web-agent/tools-mcp'
import { toManagerConfig } from './config'
import type { McpRuntimeWriters } from './runtimeWriters'
import { messageFromError } from './runtimeWriters'
import { mayLaunchMcpServer } from './stdioLaunchConsent'
import type { McpSettingsCapabilities, PersistedMcpServerConfig } from './types'

/** 建立连接只需要 manager 的这四件事。 */
export type McpConnectManager = Pick<
  McpClientManager,
  'register' | 'connect' | 'reconnect' | 'get'
>

export interface McpServerConnector {
  /** 只登记不连接（F6）：让 manager 认得这个服务，但不建立连接、不起进程。 */
  register(config: PersistedMcpServerConfig): Promise<void>
  connect(config: PersistedMcpServerConfig, options: { reconnect: boolean }): Promise<void>
}

export interface CreateMcpServerConnectorOptions {
  manager: McpConnectManager
  writers: McpRuntimeWriters
  capabilities: McpSettingsCapabilities
  /** 排到队列槽位时这个服务还在配置里吗（remove 走同一条队列）。 */
  isConfigured(id: string): boolean
}

export function createMcpServerConnector({
  manager,
  writers,
  capabilities,
  isConfigured,
}: CreateMcpServerConnectorOptions): McpServerConnector {
  const { setOperation, setRuntime, applySnapshot } = writers

  return {
    async register(config) {
      // 排在 remove 后面的登记会给刚被删掉的服务补回一条记录，让模型又能连它。
      if (!isConfigured(config.id)) return
      try {
        await manager.register(toManagerConfig(config))
      } catch (error) {
        // 登记失败只可能是配置本身非法（manager 侧的硬校验）。配置照留在列表里，
        // 但要让用户看见它连不上，而不是留一个永远「未连接」的卡片。
        setRuntime(config.id, 'error', 0, `配置无法登记：${messageFromError(error)}`)
      }
    },

    async connect(config, { reconnect }) {
      if (config.transport === 'stdio' && !capabilities.stdio) {
        setRuntime(config.id, 'error', 0, 'stdio MCP 仅可在桌面端连接')
        return
      }
      if (!mayLaunchMcpServer(config)) {
        // 调用方应当先走确认流程；走到这里说明有一条路径漏了那一步。
        setRuntime(config.id, 'error', 0, '启动命令尚未确认，未启动本地进程')
        return
      }
      setOperation(config.id, reconnect ? 'reconnect' : 'connect')
      setRuntime(config.id, reconnect ? 'reconnecting' : 'connecting')
      try {
        const knownByManager = manager.get(config.id) !== undefined
        const snapshot = reconnect && knownByManager
          ? await manager.reconnect(config.id)
          : await manager.connect(toManagerConfig(config))
        applySnapshot(snapshot)
      } catch (error) {
        // The manager already classifies connect failures as temporary
        // ('reconnecting') or permanent ('error') and emits that snapshot
        // before rejecting. Prefer it so a temporary failure isn't clobbered
        // back into 'error' here; only fall back when no snapshot exists
        // (e.g. validateConfig rejected before any record was created).
        const snapshot = manager.get(config.id)
        if (snapshot) applySnapshot(snapshot)
        else setRuntime(config.id, 'error', 0, messageFromError(error))
      } finally {
        setOperation(config.id)
      }
    },
  }
}
