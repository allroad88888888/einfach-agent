import { rootStore } from '@web-agent/core/state/rootStore'
import type { McpClientManager } from '@web-agent/tools-mcp'
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
  settingsCenterOpenAtom,
  settingsCenterTabAtom,
} from './state'
import {
  DEFAULT_MCP_JSON_DRAFT,
  EMPTY_MCP_DRAFT,
  type McpAddMode,
  type McpAddServerDraft,
  type McpSettingsCapabilities,
  type SettingsCenterTab,
} from './types'

const unconfiguredManager: McpSettingsManager = {
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

export interface ConfigureMcpSettingsOptions {
  manager: Pick<
    McpClientManager,
    'connect' | 'reconnect' | 'disconnect' | 'remove' | 'get' | 'list' | 'subscribe'
  >
  storage?: McpConfigStorage
  capabilities?: Partial<McpSettingsCapabilities>
}

export function configureMcpSettings({
  manager,
  storage = createBrowserMcpConfigStorage(),
  capabilities,
}: ConfigureMcpSettingsOptions): void {
  activeService.dispose()
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

export function hydrateMcpSettings(): Promise<void> {
  return activeService.hydrate()
}

export function openSettingsCenter(tab: SettingsCenterTab = 'mcp'): void {
  rootStore.setter(settingsCenterTabAtom, tab)
  rootStore.setter(settingsCenterOpenAtom, true)
}

export function closeSettingsCenter(): void {
  rootStore.setter(settingsCenterOpenAtom, false)
}

export function selectSettingsTab(tab: SettingsCenterTab): void {
  rootStore.setter(settingsCenterTabAtom, tab)
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
