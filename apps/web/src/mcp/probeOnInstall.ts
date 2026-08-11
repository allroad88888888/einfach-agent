// 安装即探测：新增或导入一个 MCP 服务时，趁用户还在场连一次、取回工具清单、写进缓存。
//
// 为什么是安装这一刻：服务改成「按需连接」之后，模型必须在服务【未连接时】就知道它大概
// 有哪些工具，才谈得上决定要不要调 connect_mcp_server——而这份清单的主要来源就是这次
// 一次性探测（缓存的形状与上限见 toolNameCache.ts）。顺带还解决三件事：配置当场验证
// （在此之前，保存一个地址拼错的服务毫无反馈）、授权发生在用户在场的时刻、把连接期的
// 硬失败（工具数超限、工具名碰撞）从对话中途提前到表单上。
//
// 两条硬约束：
// 1. 探测失败【绝不阻断保存】。配置照存，缓存记 probeStatus: 'failed'，结论通过 report
//    显示出来，用户可以修完再重连。探测的任何一步（连接、写缓存、断开）都不向外抛。
// 2. 缓存写入留在 app 层——tools/mcp 与 packages/agent-core 都不碰磁盘，本文件连磁盘通道
//    都不持有，只调注入的 McpToolNameCacheWrite（与 B3 的连接成功刷新共用同一个写入点，
//    理由见 toolNameCacheWriter.ts）。
//
// 本文件不 import 任何 atom / store：探测【做什么】在这里，探测结果【显示在哪】由
// service.ts 通过 report 注入。

import type {
  McpServerConfig,
  McpServerSnapshot,
} from '@web-agent/tools-mcp'
import { toManagerConfig } from './config'
import { toCachedTools, type McpToolNameCacheWrite } from './toolNameCacheWriter'
import type { PersistedMcpServerConfig } from './types'

export type McpInstallProbeOutcome =
  | { readonly kind: 'success'; readonly toolCount: number }
  | { readonly kind: 'failed'; readonly message: string }
  /** stdio：H2 的确认门上线前不探测，见 isInstallProbeSupported。 */
  | { readonly kind: 'deferred' }
  /** 排到串行槽位时服务已被删除，或 service 已 dispose。 */
  | { readonly kind: 'skipped' }

/** 探测只需要 manager 的这三件事；显式收窄，避免探测顺手做别的连接管理。 */
export interface McpInstallProbeManager {
  connect(config: McpServerConfig): Promise<McpServerSnapshot>
  disconnect(serverId: string): Promise<McpServerSnapshot | undefined>
  get(serverId: string): McpServerSnapshot | undefined
}

export interface McpInstallProbeContext {
  readonly manager: McpInstallProbeManager
  /**
   * 工具名缓存的写入点。由 service 注入而不是在这里自己造一个：它私有持有一份内存快照
   * 和一条读-改-写队列，安装探测与连接成功刷新必须共用同一个，否则两条队列各读各的旧
   * 快照，谁后写完谁覆盖对方（toolNameCacheWriter.ts 文件头有完整说明）。
   */
  readonly writeCache: McpToolNameCacheWrite
  /**
   * 复用 service 的「按 serverId 串行」队列。探测是一次真实连接，必须和删除、重连、
   * 切换自动连接排在同一条队列上，否则可能连回一个刚被删掉的服务。
   */
  runExclusive<T>(serverId: string, operation: () => Promise<T>): Promise<T>
  /** 输出用户可见的进度与结论；service 侧落在 mcpImportStatusAtom。 */
  report(text: string): void
  /** service 已 dispose，或这个服务已被删除时返回 false，用于中止后续探测。 */
  shouldProbe(serverId: string): boolean
}

export interface McpInstallProber {
  /** 单个新服务：探测一次并把结论写给用户。 */
  probeInstalled(config: PersistedMcpServerConfig): Promise<McpInstallProbeOutcome>
  /**
   * 该服务已经由调用方连上（勾了「自动连接」的服务本来就要连）：不再多连一次，
   * 直接把这条连接的工具清单收进缓存。
   *
   * 【调用约定】必须在调用方已经持有该 serverId 串行槽位的那一轮里调用——它不自己
   * 排队，否则会和外层的 runExclusive 互等。
   */
  recordConnected(config: PersistedMcpServerConfig): Promise<McpInstallProbeOutcome>
  /** 批量导入：后台逐个探测，带可见进度，最后给一次汇总。 */
  probeImported(configs: readonly PersistedMcpServerConfig[]): Promise<void>
}

/**
 * 能否在安装时探测这个服务。
 *
 * 【本限制由 H2 解除】stdio 的探测会在本机真的起一个子进程，必须先有「将执行
 * `<command> <args>`」的确认门（issue H2）才允许发生。在那之前 stdio 只留桩：
 * 这里返回 false，探测路径直接给出 deferred，绝不调 manager.connect。
 * HTTP 只发网络请求，是用户点「保存」的直接后果，不需要额外确认。
 */
export function isInstallProbeSupported(config: PersistedMcpServerConfig): boolean {
  return config.transport === 'streamable-http'
}

function probeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function snapshotFailureMessage(snapshot: McpServerSnapshot | undefined): string {
  if (!snapshot) return '连接未建立'
  const error: unknown = snapshot.error
  if (error !== undefined) return probeErrorMessage(error)
  return '连接未成功'
}

function describeInstallProbe(
  name: string,
  outcome: McpInstallProbeOutcome,
): string | undefined {
  switch (outcome.kind) {
    case 'success':
      return `已保存「${name}」：检测到 ${outcome.toolCount} 个可用工具。`
    case 'failed':
      return `已保存「${name}」，但连接检测失败：${outcome.message}。配置已保留，修正后可在下方卡片点「重连」。`
    case 'deferred':
      return `已保存「${name}」：stdio 服务会在本机启动进程，需你手动连接后才检测工具。`
    case 'skipped':
      return undefined
  }
}

function describeImportProbe(summary: {
  total: number
  succeeded: number
  failed: number
  deferred: number
}): string {
  const parts: string[] = []
  if (summary.succeeded > 0) parts.push(`${summary.succeeded} 个检测可用`)
  if (summary.failed > 0) {
    parts.push(`${summary.failed} 个检测失败（配置已保存，原因见下方卡片）`)
  }
  if (summary.deferred > 0) {
    parts.push(`${summary.deferred} 个 stdio 服务需手动连接后才检测`)
  }
  if (parts.length === 0) parts.push('未做连接检测')
  return `已导入 ${summary.total} 个 MCP 服务：${parts.join('，')}。`
}

export function createMcpInstallProber(context: McpInstallProbeContext): McpInstallProber {
  const { manager, writeCache, runExclusive, report, shouldProbe } = context

  /**
   * 探测完是否断开：只有用户勾了「自动连接」的服务才把连接留着，其余一律断开。
   *
   * 目标形态是「按需连接」——没开自动连接的服务不该在安装后一直占着连接，更不该把
   * 它的工具留在 ToolRegistry 里：留着就等于绕过了 connect_mcp_server 的惰性加载分层，
   * 模型会直接看见并调用这些工具，B4/F4 的整套语义都建立在「未连接 = 工具不在 registry」
   * 之上。另外，一次导入可能有 10 个服务，全部保持连接会同时占住 10 条会话与远端配额，
   * 而冷启动后它们又不会自动连回来，状态反而不一致。
   */
  const closeProbeConnection = async (config: PersistedMcpServerConfig): Promise<void> => {
    if (config.autoConnect) return
    try {
      await manager.disconnect(config.id)
    } catch {
      // 探测结论已经拿到了；断不开只影响这一条连接，不改变「配置可用」的结论。
    }
  }

  const runProbe = async (
    config: PersistedMcpServerConfig,
  ): Promise<McpInstallProbeOutcome> => {
    if (!isInstallProbeSupported(config)) return { kind: 'deferred' }
    return runExclusive<McpInstallProbeOutcome>(config.id, async () => {
      // 排队期间服务可能已经被删除（remove 走的是同一条队列）。
      if (!shouldProbe(config.id)) return { kind: 'skipped' }
      let snapshot: McpServerSnapshot
      try {
        snapshot = await manager.connect(toManagerConfig(config))
      } catch (error) {
        await writeCache(config.id, { tools: [], probeStatus: 'failed' })
        return { kind: 'failed', message: probeErrorMessage(error) }
      }
      await writeCache(config.id, {
        tools: toCachedTools(snapshot.tools),
        probeStatus: 'success',
      })
      await closeProbeConnection(config)
      return { kind: 'success', toolCount: snapshot.tools.length }
    })
  }

  return {
    async probeInstalled(config) {
      const outcome = await runProbe(config)
      const text = describeInstallProbe(config.name, outcome)
      if (text) report(text)
      return outcome
    },

    async recordConnected(config) {
      const snapshot = manager.get(config.id)
      let outcome: McpInstallProbeOutcome
      if (snapshot && snapshot.status === 'connected') {
        await writeCache(config.id, {
          tools: toCachedTools(snapshot.tools),
          probeStatus: 'success',
        })
        outcome = { kind: 'success', toolCount: snapshot.tools.length }
      } else {
        await writeCache(config.id, { tools: [], probeStatus: 'failed' })
        outcome = { kind: 'failed', message: snapshotFailureMessage(snapshot) }
      }
      const text = describeInstallProbe(config.name, outcome)
      if (text) report(text)
      return outcome
    },

    async probeImported(configs) {
      // 逐个而不是并发：一次导入可能 10 个，并发探测会同时打满远端与本地的连接。
      // 调用方不 await 这个 Promise——导入本身已经落盘，界面不该被 N 次连接拖住。
      const probable = configs.filter(isInstallProbeSupported)
      const deferred = configs.length - probable.length
      let succeeded = 0
      let failed = 0
      for (const [index, config] of probable.entries()) {
        if (!shouldProbe(config.id)) continue
        report(`正在检测导入的 MCP 服务（${index + 1}/${probable.length}）：${config.name}`)
        const outcome = await runProbe(config)
        if (outcome.kind === 'success') succeeded += 1
        else if (outcome.kind === 'failed') failed += 1
      }
      report(describeImportProbe({ total: configs.length, succeeded, failed, deferred }))
    },
  }
}
