import { rootStore } from '@web-agent/core/state/rootStore'
import { createBrowserMcpConfigStorage, type McpConfigStorage } from './persistence'
import { createMcpSettingsService, type McpSettingsManager, type McpSettingsService } from './service'
import {
  mcpAddModeAtom,
  mcpAddFormOpenAtom,
  mcpDraftAtom,
  mcpFormErrorAtom,
  mcpImportStatusAtom,
  mcpJsonDraftAtom,
  mcpSettingsCapabilitiesAtom,
} from './state'
import {
  DEFAULT_MCP_JSON_DRAFT,
  EMPTY_MCP_DRAFT,
  type McpAddMode,
  type McpAddServerDraft,
  type McpSettingsCapabilities,
} from './types'

const unconfiguredManager: McpSettingsManager = {
  // 只登记不连接：没有宿主 manager 时也没有登记表，回一份「未连接」快照即可，
  // 不该因为「还没装配」就把每张卡片都标成错误。
  register: async (config) => ({ id: config.id, config, status: 'disconnected', tools: [] }),
  connect: async () => {
    throw new Error('MCP manager 尚未配置')
  },
  reconnect: async () => {
    throw new Error('MCP manager 尚未配置')
  },
  disconnect: async () => undefined,
  remove: async () => false,
  get: () => undefined,
  list: () => [],
  subscribe: () => () => {},
}

let activeService: McpSettingsService = createMcpSettingsService({
  store: rootStore,
  manager: unconfiguredManager,
  storage: createBrowserMcpConfigStorage(),
})
let configured = false

export interface ConfigureMcpSettingsOptions {
  manager: McpSettingsManager
  storage?: McpConfigStorage
  capabilities?: Partial<McpSettingsCapabilities>
}

export function configureMcpSettings({
  manager,
  storage = createBrowserMcpConfigStorage(),
  capabilities,
}: ConfigureMcpSettingsOptions): void {
  activeService.dispose()
  configured = true
  const resolvedCapabilities: McpSettingsCapabilities = {
    stdio: capabilities?.stdio === true,
  }
  rootStore.setter(mcpSettingsCapabilitiesAtom, resolvedCapabilities)
  activeService = createMcpSettingsService({
    store: rootStore,
    manager,
    storage,
    capabilities: resolvedCapabilities,
  })
}

/** Reports whether an application host has replaced the unavailable MCP manager. */
export function isMcpSettingsConfigured(): boolean {
  return configured
}

export function hydrateMcpSettings(): Promise<void> {
  return activeService.hydrate()
}

export function openMcpAddForm(): void {
  rootStore.setter(mcpFormErrorAtom, undefined)
  rootStore.setter(mcpImportStatusAtom, undefined)
  rootStore.setter(mcpAddModeAtom, 'form')
  rootStore.setter(mcpDraftAtom, { ...EMPTY_MCP_DRAFT })
  rootStore.setter(mcpJsonDraftAtom, DEFAULT_MCP_JSON_DRAFT)
  rootStore.setter(mcpAddFormOpenAtom, true)
}

export function closeMcpAddForm(): void {
  rootStore.setter(mcpFormErrorAtom, undefined)
  rootStore.setter(mcpAddFormOpenAtom, false)
}

export function updateMcpDraft(patch: Partial<McpAddServerDraft>): void {
  rootStore.setter(mcpDraftAtom, (previous) => ({ ...previous, ...patch }))
  rootStore.setter(mcpFormErrorAtom, undefined)
  rootStore.setter(mcpImportStatusAtom, undefined)
}

export function selectMcpAddMode(mode: McpAddMode): void {
  rootStore.setter(mcpAddModeAtom, mode)
  rootStore.setter(mcpFormErrorAtom, undefined)
}

export function updateMcpJsonDraft(value: string): void {
  rootStore.setter(mcpJsonDraftAtom, value)
  rootStore.setter(mcpFormErrorAtom, undefined)
  rootStore.setter(mcpImportStatusAtom, undefined)
}

export function submitMcpDraft(): Promise<boolean> {
  return activeService.submitDraft()
}

export function submitMcpJsonDraft(): Promise<boolean> {
  return activeService.importJson(rootStore.getter(mcpJsonDraftAtom))
}

export function reconnectMcpServer(id: string): Promise<void> {
  return activeService.reconnect(id)
}

export function disconnectMcpServer(id: string): Promise<void> {
  return activeService.disconnect(id)
}

export function removeMcpServer(id: string): Promise<void> {
  return activeService.remove(id)
}

export function setMcpServerAutoConnect(id: string, enabled: boolean): Promise<void> {
  return activeService.setAutoConnect(id, enabled)
}

/**
 * 用户确认了「在本机执行这条命令行」（H2）。确认会落进配置，此后同一条命令行不再问；
 * 命令行被改过则自动作废，见 stdioLaunchConsent.ts。
 */
export function approveMcpServerLaunch(id: string): Promise<void> {
  return activeService.approveLaunch(id)
}

/** 用户选择暂不执行：配置照留，不起任何进程。 */
export function dismissMcpServerLaunch(id: string): void {
  activeService.dismissLaunch(id)
}
