// 「把一份草稿变成一个已保存的 MCP 服务」这条路：表单提交与 JSON 批量导入。
//
// 从 service.ts 拆出来的理由：这两条命令回答的是同一个问题——用户填的东西合不合法、
// 落盘怎么落、落完之后第一件真事是什么——与 hydrate、连接编排、删除竞态无关。service
// 那边留下的是运行期编排。
//
// 【落盘之后的三步顺序是有讲究的】保存先返回、表单先关，再做起进程确认与探测：
//   1. 保存不能被探测或确认拖住，探测失败更不能回滚保存（B2 的硬约束）。
//   2. 未确认的 stdio 只排一条确认请求，绝不在这里连（H2）；确认后走的是同一个
//      runInstallProbe，安装探测因此仍然是「首次真正起进程」的唯一时刻。

import type { Store } from '@einfach/core'
import { buildPersistedMcpConfig, validateMcpDraft } from './config'
import type { McpConfigPersist } from './configWriteQueue'
import { parseMcpJsonConfig } from './jsonConfig'
import { MCP_SETTINGS_MAX_SERVERS } from './persistence'
import type { McpInstallProber } from './probeOnInstall'
import { messageFromError, type McpRuntimeWriters } from './runtimeWriters'
import {
  mcpAddModeAtom,
  mcpAddFormOpenAtom,
  mcpDraftAtom,
  mcpFormErrorAtom,
  mcpFormSubmittingAtom,
  mcpImportStatusAtom,
  mcpJsonDraftAtom,
  mcpServerConfigsAtom,
} from './state'
import {
  DEFAULT_MCP_JSON_DRAFT,
  EMPTY_MCP_DRAFT,
  type McpSettingsCapabilities,
  type PersistedMcpServerConfig,
} from './types'

export interface McpInstallFlow {
  submitDraft(): Promise<boolean>
  importJson(jsonText: string): Promise<boolean>
}

export interface CreateMcpInstallFlowOptions {
  store: Store
  persist: McpConfigPersist
  prober: McpInstallProber
  capabilities: McpSettingsCapabilities
  createId(): string
  setRuntime: McpRuntimeWriters['setRuntime']
  /** 保存后立刻接上 manager 订阅，探测期间的状态才刷得到卡片上。 */
  ensureSubscription(): void
  /** 安装后的第一件真事：连接并记录清单，或只探测一次。 */
  runInstallProbe(config: PersistedMcpServerConfig): Promise<void>
  /** 命令行还没确认过的 stdio：排一条确认请求（不是 stdio 或已确认时什么都不做）。 */
  requestInstallConsent(config: PersistedMcpServerConfig): void
}

export function createMcpInstallFlow({
  store,
  persist,
  prober,
  capabilities,
  createId,
  setRuntime,
  ensureSubscription,
  runInstallProbe,
  requestInstallConsent,
}: CreateMcpInstallFlowOptions): McpInstallFlow {
  return {
    async submitDraft() {
      store.setter(mcpFormErrorAtom, undefined)
      store.setter(mcpImportStatusAtom, undefined)
      const draft = store.getter(mcpDraftAtom)
      if (draft.transport === 'stdio' && !capabilities.stdio) {
        store.setter(mcpFormErrorAtom, 'stdio MCP 仅可在桌面端配置和连接')
        return false
      }
      const validation = validateMcpDraft(draft)
      if (!validation.valid) {
        store.setter(mcpFormErrorAtom, Object.values(validation.errors)[0] ?? '请检查服务器配置')
        return false
      }

      if (store.getter(mcpServerConfigsAtom).length >= MCP_SETTINGS_MAX_SERVERS) {
        store.setter(
          mcpFormErrorAtom,
          `MCP 服务最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`,
        )
        return false
      }

      store.setter(mcpFormSubmittingAtom, true)
      try {
        let id = createId()
        const existingIds = new Set(store.getter(mcpServerConfigsAtom).map((config) => config.id))
        while (existingIds.has(id)) id = createId()
        const config = buildPersistedMcpConfig(draft, id)
        await persist((current) => [...current, config])
        setRuntime(config.id, 'disconnected')
        store.setter(mcpDraftAtom, { ...EMPTY_MCP_DRAFT })
        store.setter(mcpAddFormOpenAtom, false)
        store.setter(mcpFormSubmittingAtom, false)
        // 保存已经落盘、表单也已经关掉，下面这次探测不会挡住用户；探测失败也只写状态行，
        // 绝不回滚保存。订阅先接上，探测期间的 connecting/connected/disconnected 才能
        // 照常刷到卡片上（hydrate 之前就添加服务时同样成立）。
        ensureSubscription()
        // 新配置从来不带确认（buildPersistedMcpConfig 不会造出确认），所以 stdio 到这里
        // 一定要先问一次：把将执行的命令行摆给用户，确认后再由同一个 runInstallProbe
        // 继续。这一步只排队、不执行；紧接着的 runInstallProbe 对未确认的 stdio 只会
        // 拿到 deferred，把「已保存，待确认」写到状态行上。
        requestInstallConsent(config)
        await runInstallProbe(config)
        return true
      } catch (error) {
        store.setter(mcpFormErrorAtom, `无法保存 MCP 服务：${messageFromError(error)}`)
        return false
      } finally {
        store.setter(mcpFormSubmittingAtom, false)
      }
    },

    async importJson(jsonText) {
      store.setter(mcpFormErrorAtom, undefined)
      store.setter(mcpImportStatusAtom, undefined)

      let drafts
      try {
        // 桌面/浏览器两种宿主对 headers/env 的支持不同（C3）：能不能落盘凭据交给
        // capabilities.credentials 判定，而不是让 parseMcpJsonConfig 自己猜宿主。
        drafts = parseMcpJsonConfig(jsonText, { allowCredentials: capabilities.credentials })
      } catch (error) {
        store.setter(mcpFormErrorAtom, messageFromError(error))
        return false
      }

      const existing = store.getter(mcpServerConfigsAtom)
      if (existing.length + drafts.length > MCP_SETTINGS_MAX_SERVERS) {
        store.setter(
          mcpFormErrorAtom,
          `MCP 服务最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`,
        )
        return false
      }

      const existingNames = new Set(existing.map((config) => config.name.trim().toLowerCase()))
      const conflicting = drafts.find((draft) =>
        existingNames.has(draft.name.trim().toLowerCase()))
      if (conflicting) {
        store.setter(mcpFormErrorAtom, `已存在同名 MCP 服务：“${conflicting.name}”`)
        return false
      }

      store.setter(mcpFormSubmittingAtom, true)
      try {
        const reservedIds = new Set(existing.map((config) => config.id))
        const configs = drafts.map((draft) => {
          let id: string | undefined
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const candidate = createId()
            if (!reservedIds.has(candidate)) {
              id = candidate
              reservedIds.add(candidate)
              break
            }
          }
          if (!id) throw new Error('无法生成唯一的 MCP 服务标识')
          return buildPersistedMcpConfig({ ...draft, autoConnect: false }, id)
        })

        await persist((current) => [...current, ...configs])
        for (const config of configs) setRuntime(config.id, 'disconnected')
        store.setter(mcpDraftAtom, { ...EMPTY_MCP_DRAFT })
        store.setter(mcpJsonDraftAtom, DEFAULT_MCP_JSON_DRAFT)
        store.setter(mcpAddModeAtom, 'form')
        store.setter(mcpAddFormOpenAtom, false)
        store.setter(
          mcpImportStatusAtom,
          `已导入 ${configs.length} 个 MCP 服务，正在逐个检测…`,
        )
        // 导入进来的 stdio 与表单添加的一样要先确认。确认请求排在探测之外而不是塞进
        // probeImported：那是一个后台顺序循环，让它停下来等某个人点确认，会把排在后面
        // 的 HTTP 探测一起卡住。
        for (const config of configs) requestInstallConsent(config)
        // 批量探测放到后台：配置已经落盘，界面不该被 N 次连接拖住；prober 内部逐个跑，
        // 每一步都刷新上面这条状态行，最后写一次汇总。探测结论不影响导入成功与否。
        ensureSubscription()
        void prober.probeImported(configs).catch(() => undefined)
        return true
      } catch (error) {
        store.setter(mcpFormErrorAtom, `无法导入 MCP 服务：${messageFromError(error)}`)
        return false
      } finally {
        store.setter(mcpFormSubmittingAtom, false)
      }
    },
  }
}
