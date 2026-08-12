import { rootStore } from '@web-agent/core/state/rootStore'
import { createBrowserMcpConfigStorage, type McpConfigStorage } from './persistence'
import { createMcpSettingsService, type McpSettingsManager, type McpSettingsService } from './service'
import {
  listLastKnownTools,
  type McpLastKnownTools,
  type McpToolNameCache,
} from './toolNameCache'
import type { McpToolNameCacheStorage } from './toolNameCacheStorage'
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
  /** 工具名清单缓存的读写通道；默认桌面优先，浏览器/测试自动降级。 */
  toolNameCacheStorage?: McpToolNameCacheStorage
  capabilities?: Partial<McpSettingsCapabilities>
  /**
   * 工具名缓存变化时的通知，原样交给 service（D2 的占位同步器靠它重算）。
   *
   * 装配点递进来的是一个【每次调用当刻才解析】的闭包，不是同步器本身：占位同步器要等
   * manager 装好之后才造得出来，而 service 在这一步就已经建好了。
   */
  onToolNameCacheChanged?: () => void
}

export function configureMcpSettings({
  manager,
  storage = createBrowserMcpConfigStorage(),
  toolNameCacheStorage,
  capabilities,
  onToolNameCacheChanged,
}: ConfigureMcpSettingsOptions): void {
  activeService.dispose()
  configured = true
  const resolvedCapabilities: McpSettingsCapabilities = {
    stdio: capabilities?.stdio === true,
    credentials: capabilities?.credentials === true,
  }
  rootStore.setter(mcpSettingsCapabilitiesAtom, resolvedCapabilities)
  activeService = createMcpSettingsService({
    store: rootStore,
    manager,
    storage,
    ...(toolNameCacheStorage ? { toolNameCacheStorage } : {}),
    capabilities: resolvedCapabilities,
    ...(onToolNameCacheChanged ? { onToolNameCacheChanged } : {}),
  })
}

/**
 * 进程内工具名缓存的读出口（B5）。
 *
 * 【为什么经这里而不是直接抓 service】configureMcpSettings 会换掉 activeService，而
 * B4 / F4 的两根线在装配期就接好了、之后不再重接。让它们闭包住这个函数（每次调用当刻
 * 才解析 activeService），换 service 之后取到的就是新那份缓存，不会读着一个已经 dispose
 * 掉的旧服务。取到的是缓存持有者交出的同一个对象引用，不是拷贝。
 */
export function readMcpToolNameCache(): McpToolNameCache {
  return activeService.readToolNameCache()
}

/** 未连接服务【上次已知】的工具清单，供 connect_mcp_server 的描述使用（F4）。 */
export function listMcpLastKnownTools(): readonly McpLastKnownTools[] {
  return listLastKnownTools(readMcpToolNameCache())
}

/** 这个服务此刻是否已连接（以 manager 的登记表为准）。B4 的探针靠它闭嘴。 */
export function isMcpServerConnected(id: string): boolean {
  return activeService.isServerConnected(id)
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
