// apps/web/src/plugins/toggleStorage.ts —— 插件启停记录的存储实现
// ---------------------------------------------------------------------------
// 只做一件事：把 PluginToggleRecord 读/写到一个具体介质。localStorage 实现对齐
// apps/web/src/mcp/persistence.ts 的 createBrowserMcpConfigStorage 写法——
// 特性检测 + 出错静默降级到内存，不让"存储不可用"变成一个会炸的异常。

import type { PluginToggleRecord, PluginToggleStorage } from './types'

export const PLUGIN_TOGGLES_STORAGE_KEY = 'web-agent.plugin-toggles.v1'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PersistedToggleEnvelope {
  version: 1
  disabled: Record<string, boolean>
}

function sanitizeRecord(value: unknown): PluginToggleRecord {
  if (typeof value !== 'object' || value === null) return {}
  const record: Record<string, boolean> = {}
  for (const [id, disabled] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === 'string' && id.length > 0 && disabled === true) record[id] = true
  }
  return record
}

function parseEnvelope(raw: string): PluginToggleRecord {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return {}
  const envelope = parsed as Partial<PersistedToggleEnvelope>
  return sanitizeRecord(envelope.disabled)
}

export function createLocalStoragePluginToggleStorage(
  storage: StorageLike | undefined = safeLocalStorage(),
): PluginToggleStorage {
  if (!storage) return createMemoryPluginToggleStorage()
  return {
    load() {
      try {
        const raw = storage.getItem(PLUGIN_TOGGLES_STORAGE_KEY)
        return raw ? parseEnvelope(raw) : {}
      } catch {
        // 读损坏数据不该炸整个设置面板：当作"还没有任何停用记录"。
        return {}
      }
    },
    save(record) {
      const envelope: PersistedToggleEnvelope = { version: 1, disabled: { ...record } }
      try {
        storage.setItem(PLUGIN_TOGGLES_STORAGE_KEY, JSON.stringify(envelope))
      } catch {
        // 只读/配额已满的宿主：静默丢弃这次持久化，不阻塞当前这次启停操作本身。
      }
    },
  }
}

/** 测试与"未配置/不支持插件的宿主"默认用的纯内存实现，不落盘。 */
export function createMemoryPluginToggleStorage(
  initial: PluginToggleRecord = {},
): PluginToggleStorage {
  let record: PluginToggleRecord = sanitizeRecord(initial)
  return {
    load: () => record,
    save(next) {
      record = sanitizeRecord(next)
    },
  }
}

function safeLocalStorage(): StorageLike | undefined {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // 沙箱化浏览器可能暴露 localStorage 但访问即抛错。
  }
  return undefined
}
