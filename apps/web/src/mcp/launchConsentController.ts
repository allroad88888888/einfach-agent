// 「首次起进程前的确认」这道门本身（H2）。
//
// 它管三件事，且只管这三件事：
//   1. 把一个「还不能起进程的 stdio 服务」连同它将执行的命令行排进待确认队列；
//   2. 用户点确认后，先把确认【落进配置】，再执行请求方当初留下的那一步；
//   3. 用户点暂不、或服务被删掉时，把请求撤掉。
//
// 【为什么不是工具确认卡片】F3 已经给 `connect_mcp_server` 装了 dangerous 分级，那是
// 【模型发起连接】时的门，走 pendingToolConfirmation → ToolConfirmCard。本文件守的是
// 另一条路径：用户在设置里添加 / 导入 / 重连 / 打开自动连接。这条路径根本不经过模型，
// 借用工具确认会凭空造出一次不存在的工具调用。
//
// 【回调不进 atom】队列 atom 里只放展示字段（launchConsentState.ts）；「确认后要做什么」
// 是一个闭包，留在本模块的私有 Map 里。UI 因此仍然只读得到数据。
//
// 【确认认的是当时摆出来的那条命令行】approve 会重新算一次指纹，与请求发出时记下的那个
// 比对；对不上就整条作废，宁可再问一次。这样即便将来加了配置编辑界面（F6 的实现者警告
// 过的那条路），「编辑完成 + 旧确认弹窗还开着」也不会把授权套到新命令上。

import type { Store } from '@einfach/core'
import type { McpConfigPersist } from './configWriteQueue'
import {
  mcpPendingLaunchConsentsAtom,
  resetMcpLaunchConsentState,
  type McpLaunchConsentReason,
  type McpLaunchConsentRequest,
} from './launchConsentState'
import {
  grantStdioLaunchConsent,
  stdioCommandLine,
  stdioLaunchEnvNames,
  stdioLaunchFingerprint,
} from './stdioLaunchConsent'
import type { PersistedMcpServerConfig, PersistedStdioMcpServer } from './types'

/** 确认通过后要执行的那一步，拿到的是已经写入确认的新配置。 */
export type McpLaunchConsentRun = (config: PersistedMcpServerConfig) => Promise<void>

export interface McpLaunchConsentController {
  /** 排一个待确认请求；【绝不】在这里执行 run，调用方也不该假设它会同步发生。 */
  request(
    config: PersistedStdioMcpServer,
    reason: McpLaunchConsentReason,
    run: McpLaunchConsentRun,
  ): void
  approve(id: string): Promise<void>
  dismiss(id: string): void
  /** service 被替换或 dispose：整队作废。 */
  reset(): void
}

export interface CreateMcpLaunchConsentControllerOptions {
  store: Store
  /** 复用 A3 的原子读-改-写队列，确认落盘不能丢掉并发的其它写入。 */
  persist: McpConfigPersist
  configById(id: string): PersistedMcpServerConfig | undefined
  /** 落盘失败时把话说到卡片上；确认这种明确的用户动作不该静默失败。 */
  reportError(id: string, message: string): void
  now?(): number
}

interface PendingEntry {
  readonly fingerprint: string
  readonly run: McpLaunchConsentRun
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

export function createMcpLaunchConsentController({
  store,
  persist,
  configById,
  reportError,
  now = Date.now,
}: CreateMcpLaunchConsentControllerOptions): McpLaunchConsentController {
  const entries = new Map<string, PendingEntry>()
  // 新 service 实例 = 新队列：上一实例留下的待确认项不该还能点。
  resetMcpLaunchConsentState(store)

  const forget = (id: string): void => {
    entries.delete(id)
    store.setter(mcpPendingLaunchConsentsAtom, (previous) => {
      if (!(id in previous)) return previous
      const next = { ...previous }
      delete next[id]
      return next
    })
  }

  return {
    request(config, reason, run) {
      entries.set(config.id, { fingerprint: stdioLaunchFingerprint(config), run })
      // 指纹盖到哪，卡片就要摆到哪：cwd 与 env 都不在 commandLine 字符串里，不单独摆出来
      // 用户批准的东西就比他看到的多（C2a）。
      const envNames = stdioLaunchEnvNames(config)
      const view: McpLaunchConsentRequest = {
        id: config.id,
        name: config.name,
        commandLine: stdioCommandLine(config),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(envNames.length > 0 ? { envNames } : {}),
        reason,
        autoConnect: config.autoConnect,
      }
      store.setter(mcpPendingLaunchConsentsAtom, (previous) => ({
        ...previous,
        [config.id]: view,
      }))
    },

    async approve(id) {
      const entry = entries.get(id)
      if (!entry) return
      forget(id)
      const config = configById(id)
      // 排队期间服务被删掉，或者（将来）被改成了 HTTP：这次确认没有对象了。
      if (!config || config.transport !== 'stdio') return
      if (stdioLaunchFingerprint(config) !== entry.fingerprint) return

      let granted: PersistedMcpServerConfig | undefined
      try {
        const next = await persist((current) => current.map((item) => (
          item.id === id
            && item.transport === 'stdio'
            && stdioLaunchFingerprint(item) === entry.fingerprint
            ? grantStdioLaunchConsent(item, now())
            : item
        )))
        granted = next.find((item) => item.id === id)
      } catch (error) {
        reportError(id, `无法保存启动确认：${messageFromError(error)}`)
        return
      }
      // 落盘那一轮里配置又变了（指纹已对不上，或服务已被删）：不执行。
      if (!granted || granted.transport !== 'stdio' || !granted.launchConsent) return
      await entry.run(granted)
    },

    dismiss(id) {
      forget(id)
    },

    reset() {
      entries.clear()
      resetMcpLaunchConsentState(store)
    },
  }
}
