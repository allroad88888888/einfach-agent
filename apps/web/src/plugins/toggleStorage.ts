// apps/web/src/plugins/toggleStorage.ts —— 插件启停/工具勾选记录的存储实现
// ---------------------------------------------------------------------------
// 只做一件事：把 PluginToggleState 读/写到一个具体介质。localStorage 实现对齐
// apps/web/src/mcp/persistence.ts 的 createBrowserMcpConfigStorage 写法——
// 特性检测 + 出错静默降级到内存，不让"存储不可用"变成一个会炸的异常。
//
// 记录形状随 P6 从 v1（只有 disabled）扩到 v2（disabled + tools）。兼容策略取最简：
// **读旧写新**——沿用同一个 storage key，解析时按字段各自缺省（v1 记录没有 tools 字段，
// 读成"一个工具都没勾"，正是拍板 3 的默认关），下一次 save 自然落成 v2。没有独立的
// 迁移步骤，也就没有"迁移跑到一半"的中间态。

import type {
  PluginToggleRecord,
  PluginToggleState,
  PluginToggleStorage,
  PluginToolToggleRecord,
} from './types'

/** key 保持 v1 的字面量：换 key 等于把老用户已有的停用记录丢掉，而记录形状本身向下兼容。 */
export const PLUGIN_TOGGLES_STORAGE_KEY = 'web-agent.plugin-toggles.v1'

export const EMPTY_PLUGIN_TOGGLE_STATE: PluginToggleState = { disabled: {}, tools: {} }

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PersistedToggleEnvelope {
  version: 2
  disabled: Record<string, boolean>
  tools: Record<string, Record<string, boolean>>
}

function sanitizeFlagRecord(value: unknown): PluginToggleRecord {
  if (typeof value !== 'object' || value === null) return {}
  const record: Record<string, boolean> = {}
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 0 && flag === true) record[key] = true
  }
  return record
}

function sanitizeToolRecord(value: unknown): PluginToolToggleRecord {
  if (typeof value !== 'object' || value === null) return {}
  const record: Record<string, PluginToggleRecord> = {}
  for (const [pluginId, tools] of Object.entries(value as Record<string, unknown>)) {
    if (pluginId.length === 0) continue
    const sanitized = sanitizeFlagRecord(tools)
    // 空对象不留：勾选记录只记 true，全取消就该等价于"从没勾过"。
    if (Object.keys(sanitized).length > 0) record[pluginId] = sanitized
  }
  return record
}

export function sanitizeToggleState(value: Partial<PluginToggleState> | undefined): PluginToggleState {
  return {
    disabled: sanitizeFlagRecord(value?.disabled),
    tools: sanitizeToolRecord(value?.tools),
  }
}

function parseEnvelope(raw: string): PluginToggleState {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_PLUGIN_TOGGLE_STATE
  // 不按 version 分支：v1 与 v2 的差别只是 tools 字段的有无，各字段独立缺省即可兼容。
  const envelope = parsed as Partial<PersistedToggleEnvelope>
  return sanitizeToggleState({ disabled: envelope.disabled, tools: envelope.tools })
}

export function createLocalStoragePluginToggleStorage(
  storage: StorageLike | undefined = safeLocalStorage(),
): PluginToggleStorage {
  if (!storage) return createMemoryPluginToggleStorage()
  return {
    load() {
      try {
        const raw = storage.getItem(PLUGIN_TOGGLES_STORAGE_KEY)
        return raw ? parseEnvelope(raw) : EMPTY_PLUGIN_TOGGLE_STATE
      } catch {
        // 读损坏数据不该炸整个设置面板：当作"还没有任何停用/勾选记录"。
        return EMPTY_PLUGIN_TOGGLE_STATE
      }
    },
    save(state) {
      const sanitized = sanitizeToggleState(state)
      const envelope: PersistedToggleEnvelope = {
        version: 2,
        disabled: { ...sanitized.disabled },
        tools: { ...sanitized.tools },
      }
      try {
        storage.setItem(PLUGIN_TOGGLES_STORAGE_KEY, JSON.stringify(envelope))
      } catch {
        // 只读/配额已满的宿主：静默丢弃这次持久化，不阻塞当前这次启停/勾选操作本身。
      }
    },
  }
}

/** 测试与"未配置/不支持插件的宿主"默认用的纯内存实现，不落盘。 */
export function createMemoryPluginToggleStorage(
  initial: Partial<PluginToggleState> = {},
): PluginToggleStorage {
  let state = sanitizeToggleState(initial)
  return {
    load: () => state,
    save(next) {
      state = sanitizeToggleState(next)
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
