import type { Store } from '@einfach/core'
import type {
  McpClientManager,
  McpServerSnapshot,
  McpServerStatus,
} from '@web-agent/tools-mcp'
import { buildPersistedMcpConfig, toManagerConfig, validateMcpDraft } from './config'
import { parseMcpJsonConfig } from './jsonConfig'
import {
  MCP_SETTINGS_MAX_SERVERS,
  type McpConfigStorage,
} from './persistence'
import { createMcpInstallProber } from './probeOnInstall'
import {
  createDesktopToolNameCacheStorage,
  type McpToolNameCacheStorage,
} from './toolNameCacheStorage'
import {
  mcpAddModeAtom,
  mcpAddFormOpenAtom,
  mcpDraftAtom,
  mcpFormErrorAtom,
  mcpFormSubmittingAtom,
  mcpHydrationAtom,
  mcpImportStatusAtom,
  mcpJsonDraftAtom,
  mcpPersistenceModeAtom,
  mcpServerConfigsAtom,
  mcpServerOperationsAtom,
  mcpServerRuntimeAtom,
} from './state'
import {
  DEFAULT_MCP_JSON_DRAFT,
  EMPTY_MCP_DRAFT,
  type McpServerOperation,
  type McpSettingsCapabilities,
  type PersistedMcpServerConfig,
} from './types'

export type McpSettingsManager = Pick<
  McpClientManager,
  'connect' | 'reconnect' | 'disconnect' | 'remove' | 'get' | 'list' | 'subscribe'
>

export interface CreateMcpSettingsServiceOptions {
  store: Store
  manager: McpSettingsManager
  storage: McpConfigStorage
  /** 安装探测写工具名清单缓存的通道；默认桌面优先，浏览器/测试自动降级。 */
  toolNameCacheStorage?: McpToolNameCacheStorage
  capabilities?: Partial<McpSettingsCapabilities>
  createId?: () => string
}

export interface McpSettingsService {
  hydrate(): Promise<void>
  submitDraft(): Promise<boolean>
  importJson(jsonText: string): Promise<boolean>
  reconnect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  remove(id: string): Promise<void>
  setAutoConnect(id: string, enabled: boolean): Promise<void>
  dispose(): void
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function snapshotError(snapshot: McpServerSnapshot): string | undefined {
  const error: unknown = snapshot.error
  return error === undefined ? undefined : messageFromError(error)
}

function randomServerId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `mcp-${uuid}`
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createMcpSettingsService({
  store,
  manager,
  storage,
  toolNameCacheStorage = createDesktopToolNameCacheStorage(),
  capabilities: requestedCapabilities,
  createId = randomServerId,
}: CreateMcpSettingsServiceOptions): McpSettingsService {
  const capabilities: McpSettingsCapabilities = {
    stdio: requestedCapabilities?.stdio === true,
  }
  let unsubscribe: (() => void) | undefined
  let hydratePromise: Promise<void> | undefined
  let disposed = false

  store.setter(mcpPersistenceModeAtom, storage.persistence)
  const serverQueues = new Map<string, Promise<void>>()

  const enqueueServerOperation = <T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = serverQueues.get(id) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(operation)
    const settled = current.then(
      () => undefined,
      () => undefined,
    )
    serverQueues.set(id, settled)
    void settled.finally(() => {
      if (serverQueues.get(id) === settled) serverQueues.delete(id)
    })
    return current
  }

  const setOperation = (id: string, operation?: McpServerOperation): void => {
    store.setter(mcpServerOperationsAtom, (previous) => {
      const next = { ...previous }
      if (operation) next[id] = operation
      else delete next[id]
      return next
    })
  }

  const setRuntime = (
    id: string,
    status: McpServerStatus,
    toolCount = 0,
    error?: string,
  ): void => {
    store.setter(mcpServerRuntimeAtom, (previous) => ({
      ...previous,
      [id]: { status, toolCount, ...(error ? { error } : {}) },
    }))
  }

  const applySnapshot = (snapshot: McpServerSnapshot): void => {
    setRuntime(snapshot.id, snapshot.status, snapshot.tools.length, snapshotError(snapshot))
  }

  const applySnapshots = (snapshots: readonly McpServerSnapshot[]): void => {
    const configuredIds = new Set(store.getter(mcpServerConfigsAtom).map((config) => config.id))
    for (const snapshot of snapshots) {
      if (configuredIds.has(snapshot.id)) applySnapshot(snapshot)
    }
  }

  const ensureSubscription = (): void => {
    if (unsubscribe || disposed) return
    unsubscribe = manager.subscribe((snapshots) => {
      if (!disposed) applySnapshots(snapshots)
    })
  }

  const configById = (id: string): PersistedMcpServerConfig | undefined =>
    store.getter(mcpServerConfigsAtom).find((config) => config.id === id)

  const connectConfig = async (
    config: PersistedMcpServerConfig,
    reconnect: boolean,
  ): Promise<void> => {
    if (config.transport === 'stdio' && !capabilities.stdio) {
      setRuntime(config.id, 'error', 0, 'stdio MCP 仅可在桌面端连接')
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
  }

  // Serializes every "read atom -> compute next -> await storage.save ->
  // write atom" turn across ALL callers (submitDraft, importJson, remove,
  // setAutoConnect), not just per-serverId the way enqueueServerOperation
  // does. storage.save() awaits a real IPC round trip in the Tauri-backed
  // implementation, which opens a yield point between reading the atom and
  // committing the write. Two operations on different serverIds are NOT
  // serialized against each other by enqueueServerOperation, so without a
  // queue here each could read the same stale mcpServerConfigsAtom snapshot,
  // compute divergent "next" lists, and race to persist — the later
  // storage.save()/setter wins and silently drops the other's change, on
  // disk as well as in memory. Taking an update function instead of a
  // precomputed list, and reading store.getter() only inside the queued
  // turn, is what makes read-modify-write atomic again despite the await.
  let persistQueue: Promise<void> = Promise.resolve()
  const persist = (
    update: (
      current: readonly PersistedMcpServerConfig[],
    ) => readonly PersistedMcpServerConfig[],
  ): Promise<readonly PersistedMcpServerConfig[]> => {
    let next: readonly PersistedMcpServerConfig[] = []
    const turn = persistQueue.then(async () => {
      next = update(store.getter(mcpServerConfigsAtom))
      await storage.save(next)
      store.setter(mcpServerConfigsAtom, next)
    })
    persistQueue = turn.catch(() => undefined)
    return turn.then(() => next)
  }

  // 安装即探测（B2）。探测本身是一块独立逻辑，放在 probeOnInstall.ts；这里只把它接到
  // service 已有的三样东西上：按 serverId 的串行队列、用户可见的状态行、以及「这个服务
  // 是否还在（没被删、service 没 dispose）」的判断。
  const prober = createMcpInstallProber({
    manager,
    cacheStorage: toolNameCacheStorage,
    runExclusive: enqueueServerOperation,
    report: (text) => {
      if (!disposed) store.setter(mcpImportStatusAtom, text)
    },
    shouldProbe: (id) => !disposed && configById(id) !== undefined,
  })

  const hydrate = (): Promise<void> => {
    if (hydratePromise) return hydratePromise
    let succeeded = false
    const attempt = (async () => {
      store.setter(mcpHydrationAtom, { status: 'loading' })
      try {
        const loadedConfigs = await storage.load()
        if (loadedConfigs.length > MCP_SETTINGS_MAX_SERVERS) {
          throw new Error(`MCP 服务最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`)
        }
        const configs = loadedConfigs.map((config) =>
          config.transport === 'stdio' && config.autoConnect
            ? { ...config, autoConnect: false }
            : config,
        )
        if (configs.some((config, index) => config !== loadedConfigs[index])) {
          await storage.save(configs)
        }
        store.setter(mcpServerConfigsAtom, configs)
        store.setter(
          mcpServerRuntimeAtom,
          Object.fromEntries(configs.map((config) => [
            config.id,
            { status: 'disconnected' as const, toolCount: 0 },
          ])),
        )
        ensureSubscription()
        applySnapshots(manager.list())
        await Promise.all(
          configs
            .filter((config) => config.transport === 'streamable-http' && config.autoConnect)
            .map((config) =>
              enqueueServerOperation(config.id, () => connectConfig(config, false))),
        )
        store.setter(mcpHydrationAtom, { status: 'ready' })
        succeeded = true
      } catch (error) {
        store.setter(mcpHydrationAtom, {
          status: 'error',
          error: `无法读取 MCP 设置：${messageFromError(error)}`,
        })
      }
    })()
    hydratePromise = attempt.finally(() => {
      if (!succeeded) hydratePromise = undefined
    })
    return hydratePromise
  }

  return {
    hydrate,
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
        if (config.autoConnect) {
          // 勾了自动连接的服务本来就要连——复用这一次连接的结果，不再为探测多连一次
          // （对同一个 id 连第二次会先关掉第一条连接，纯属浪费和噪音）。
          await enqueueServerOperation(config.id, async () => {
            await connectConfig(config, false)
            // 已经持有该 serverId 的串行槽位，recordConnected 按约定不再自己排队。
            await prober.recordConnected(config)
          })
        } else {
          await prober.probeInstalled(config)
        }
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
        drafts = parseMcpJsonConfig(jsonText)
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
          return buildPersistedMcpConfig(
            { ...draft, autoConnect: false },
            id,
          )
        })

        await persist((current) => [...current, ...configs])
        store.setter(mcpServerRuntimeAtom, (previous) => ({
          ...previous,
          ...Object.fromEntries(configs.map((config) => [
            config.id,
            { status: 'disconnected' as const, toolCount: 0 },
          ])),
        }))
        store.setter(mcpDraftAtom, { ...EMPTY_MCP_DRAFT })
        store.setter(mcpJsonDraftAtom, DEFAULT_MCP_JSON_DRAFT)
        store.setter(mcpAddModeAtom, 'form')
        store.setter(mcpAddFormOpenAtom, false)
        store.setter(
          mcpImportStatusAtom,
          `已导入 ${configs.length} 个 MCP 服务，正在逐个检测…`,
        )
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
    async reconnect(id) {
      await enqueueServerOperation(id, async () => {
        const config = configById(id)
        if (!config) return
        await connectConfig(config, true)
      })
    },
    async disconnect(id) {
      await enqueueServerOperation(id, async () => {
        if (!configById(id)) return
        setOperation(id, 'disconnect')
        try {
          const snapshot = await manager.disconnect(id)
          if (snapshot) applySnapshot(snapshot)
          else setRuntime(id, 'disconnected')
        } catch (error) {
          setRuntime(id, 'error', 0, messageFromError(error))
        } finally {
          setOperation(id)
        }
      })
    },
    async remove(id) {
      await enqueueServerOperation(id, async () => {
        if (!configById(id)) return
        setOperation(id, 'remove')
        try {
          await manager.remove(id)
          await persist((current) => current.filter((config) => config.id !== id))
          store.setter(mcpServerRuntimeAtom, (previous) => {
            const nextRuntime = { ...previous }
            delete nextRuntime[id]
            return nextRuntime
          })
        } catch (error) {
          setRuntime(id, 'error', 0, `删除失败：${messageFromError(error)}`)
        } finally {
          setOperation(id)
        }
      })
    },
    async setAutoConnect(id, enabled) {
      await enqueueServerOperation(id, async () => {
        const config = configById(id)
        if (!config || config.autoConnect === enabled) return
        if (config.transport === 'stdio') {
          return
        }
        try {
          const next = await persist((current) => current.map((entry) =>
            entry.id === id ? { ...entry, autoConnect: enabled } : entry,
          ))
          const updated = next.find((entry) => entry.id === id)
          if (!updated) return
          if (enabled) await connectConfig(updated, false)
          else {
            setOperation(id, 'disconnect')
            try {
              const snapshot = await manager.disconnect(id)
              if (snapshot) applySnapshot(snapshot)
              else setRuntime(id, 'disconnected')
            } finally {
              setOperation(id)
            }
          }
        } catch (error) {
          setRuntime(id, 'error', 0, messageFromError(error))
          setOperation(id)
        }
      })
    },
    dispose() {
      disposed = true
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
