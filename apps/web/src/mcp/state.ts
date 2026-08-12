import { atom } from '@einfach/react'
import type { Store } from '@einfach/core'
import { validateMcpDraft } from './config'
import { readLastKnownTools, type McpToolNameCache } from './toolNameCache'
import {
  EMPTY_MCP_DRAFT,
  DEFAULT_MCP_JSON_DRAFT,
  type McpAddMode,
  type McpAddServerDraft,
  type McpHydrationState,
  type McpPersistenceMode,
  type McpSettingsCapabilities,
  type McpServerOperation,
  type McpServerRuntime,
  type McpServerView,
  type PersistedMcpServerConfig,
} from './types'

export const mcpSettingsCapabilitiesAtom = atom<McpSettingsCapabilities>({
  stdio: false,
  credentials: false,
})
mcpSettingsCapabilitiesAtom.debugLabel = 'mcpSettingsCapabilities'

export const mcpAddFormOpenAtom = atom(false)
mcpAddFormOpenAtom.debugLabel = 'mcpAddFormOpen'

export const mcpAddModeAtom = atom<McpAddMode>('form')
mcpAddModeAtom.debugLabel = 'mcpAddMode'

export const mcpDraftAtom = atom<McpAddServerDraft>({ ...EMPTY_MCP_DRAFT })
mcpDraftAtom.debugLabel = 'mcpDraft'

export const mcpJsonDraftAtom = atom(DEFAULT_MCP_JSON_DRAFT)
mcpJsonDraftAtom.debugLabel = 'mcpJsonDraft'

export const mcpFormErrorAtom = atom<string | undefined>(undefined)
mcpFormErrorAtom.debugLabel = 'mcpFormError'

export const mcpFormSubmittingAtom = atom(false)
mcpFormSubmittingAtom.debugLabel = 'mcpFormSubmitting'

export const mcpImportStatusAtom = atom<string | undefined>(undefined)
mcpImportStatusAtom.debugLabel = 'mcpImportStatus'

export const mcpHydrationAtom = atom<McpHydrationState>({ status: 'idle' })
mcpHydrationAtom.debugLabel = 'mcpHydration'

export const mcpPersistenceModeAtom = atom<McpPersistenceMode>('temporary')
mcpPersistenceModeAtom.debugLabel = 'mcpPersistenceMode'

export const mcpServerConfigsAtom = atom<readonly PersistedMcpServerConfig[]>([])
mcpServerConfigsAtom.debugLabel = 'mcpServerConfigs'

export const mcpServerRuntimeAtom = atom<Readonly<Record<string, McpServerRuntime>>>({})
mcpServerRuntimeAtom.debugLabel = 'mcpServerRuntime'

export const mcpServerOperationsAtom = atom<Readonly<Record<string, McpServerOperation>>>({})
mcpServerOperationsAtom.debugLabel = 'mcpServerOperations'

/**
 * 工具名缓存在界面这一侧的只读投影（B5）。由 toolNameCacheProjection.ts 推入，
 * 内容是缓存持有者交出的同一个对象引用——不是第二份快照，也没有反向写回。
 */
export const mcpLastKnownToolsAtom = atom<McpToolNameCache>({})
mcpLastKnownToolsAtom.debugLabel = 'mcpLastKnownTools'

export const mcpDraftValidationAtom = atom((get) => {
  const draft = get(mcpDraftAtom)
  const validation = validateMcpDraft(draft)
  const capabilities = get(mcpSettingsCapabilitiesAtom)
  let valid = validation.valid
  let errors = validation.errors

  if (draft.transport === 'stdio' && !capabilities.stdio) {
    valid = false
    errors = { ...errors, transport: 'stdio MCP 仅可在桌面端配置和连接' }
  }

  // 输入框在浏览器宿主下是禁用的（见 McpCredentialField），这里是第二道防线：即便
  // 某种方式绕过了禁用输入（比如一份手造的 draft），凭据文本框有内容也不该在浏览器
  // 宿主上放行提交——凭据的唯一落点是桌面配置文件，没有 credentials 能力就没地方存。
  if (!capabilities.credentials) {
    const field = draft.transport === 'streamable-http' ? 'headersText' : 'envText'
    if (draft[field]?.trim()) {
      valid = false
      errors = { ...errors, [field]: '凭据字段仅桌面端支持' }
    }
  }

  return { valid, errors }
})
mcpDraftValidationAtom.debugLabel = 'mcpDraftValidation'

export const mcpServersAtom = atom<readonly McpServerView[]>((get) => {
  const runtimeById = get(mcpServerRuntimeAtom)
  // 「上次已知」的清单只挂上去，不参与 runtime 的任何字段：卡片上的 toolCount 是当前
  // 连接的真实工具数，lastKnownTools 是历史。两者同名不同源，混在一起就会把「上次探测到
  // 3 个」说成「现在有 3 个工具」。从未探测过的服务这里【没有】这个字段，不是空清单。
  const lastKnownCache = get(mcpLastKnownToolsAtom)
  return get(mcpServerConfigsAtom).map((config) => {
    const runtime = runtimeById[config.id] ?? {
      status: 'disconnected' as const,
      toolCount: 0,
    }
    const lastKnownTools = readLastKnownTools(lastKnownCache, config.id)
    return {
      id: config.id,
      name: config.name,
      transport: config.transport,
      target: config.transport === 'streamable-http' ? config.url : config.command,
      autoConnect: config.autoConnect,
      args: config.transport === 'stdio' ? config.args : [],
      ...(config.transport === 'stdio' && config.cwd ? { cwd: config.cwd } : {}),
      ...(lastKnownTools ? { lastKnownTools } : {}),
      ...runtime,
    }
  })
})
mcpServersAtom.debugLabel = 'mcpServers'

export function resetMcpSettingsState(store: Store): void {
  store.setter(mcpSettingsCapabilitiesAtom, { stdio: false, credentials: false })
  store.setter(mcpAddFormOpenAtom, false)
  store.setter(mcpAddModeAtom, 'form')
  store.setter(mcpDraftAtom, { ...EMPTY_MCP_DRAFT })
  store.setter(mcpJsonDraftAtom, DEFAULT_MCP_JSON_DRAFT)
  store.setter(mcpFormErrorAtom, undefined)
  store.setter(mcpFormSubmittingAtom, false)
  store.setter(mcpImportStatusAtom, undefined)
  store.setter(mcpHydrationAtom, { status: 'idle' })
  store.setter(mcpPersistenceModeAtom, 'temporary')
  store.setter(mcpServerConfigsAtom, [])
  store.setter(mcpServerRuntimeAtom, {})
  store.setter(mcpServerOperationsAtom, {})
  store.setter(mcpLastKnownToolsAtom, {})
}
