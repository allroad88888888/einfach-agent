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

  const persist = (configs: readonly PersistedMcpServerConfig[]): void => {
    storage.save(configs)
    store.setter(mcpServerConfigsAtom, configs)
  }

  const hydrate = (): Promise<void> => {
    if (hydratePromise) return hydratePromise
    let succeeded = false
    const attempt = (async () => {
      store.setter(mcpHydrationAtom, { status: 'loading' })
      try {
        const loadedConfigs = storage.load()
        if (loadedConfigs.length > MCP_SETTINGS_MAX_SERVERS) {
          throw new Error(`MCP 服务最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`)
        }
        const configs = loadedConfigs.map((config) =>
          config.transport === 'stdio' && config.autoConnect
            ? { ...config, autoConnect: false }
            : config,
        )
        if (configs.some((config, index) => config !== loadedConfigs[index])) {
          storage.save(configs)
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
        const next = [...store.getter(mcpServerConfigsAtom), config]
        persist(next)
        setRuntime(config.id, 'disconnected')
        store.setter(mcpDraftAtom, { ...EMPTY_MCP_DRAFT })
        store.setter(mcpAddFormOpenAtom, false)
        store.setter(mcpFormSubmittingAtom, false)
        if (config.autoConnect) {
          await enqueueServerOperation(config.id, () => connectConfig(config, false))
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

        persist([...existing, ...configs])
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
          `已导入 ${configs.length} 个 MCP 服务，均保持未连接`,
        )
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
          const next = store.getter(mcpServerConfigsAtom).filter((config) => config.id !== id)
          persist(next)
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
          const next = store.getter(mcpServerConfigsAtom).map((entry) =>
            entry.id === id ? { ...entry, autoConnect: enabled } : entry,
          )
          persist(next)
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
