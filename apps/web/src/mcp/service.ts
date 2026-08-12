import type { Store } from '@einfach/core'
import type { McpClientManager } from '@web-agent/tools-mcp'
import { createMcpConfigWriteQueue } from './configWriteQueue'
import { createMcpInstallFlow } from './installFlow'
import { createMcpLaunchConsentController } from './launchConsentController'
import {
  MCP_SETTINGS_MAX_SERVERS,
  type McpConfigStorage,
} from './persistence'
import { createMcpInstallProber } from './probeOnInstall'
import { createMcpConnectedCacheRefresher } from './refreshOnConnect'
import { createMcpRuntimeWriters, messageFromError } from './runtimeWriters'
import { createMcpServerConnector } from './serverConnector'
import { createMcpServerOperationQueue } from './serverOperationQueue'
import { mayLaunchMcpServer } from './stdioLaunchConsent'
import {
  createDesktopToolNameCacheStorage,
  type McpToolNameCacheStorage,
} from './toolNameCacheStorage'
import { createMcpToolNameCacheProjection } from './toolNameCacheProjection'
import { createMcpToolNameCacheHandle } from './toolNameCacheWriter'
import type { McpToolNameCache } from './toolNameCache'
import {
  mcpHydrationAtom,
  mcpImportStatusAtom,
  mcpPersistenceModeAtom,
  mcpServerConfigsAtom,
  mcpServerRuntimeAtom,
} from './state'
import type {
  McpSettingsCapabilities,
  PersistedMcpServerConfig,
  PersistedStdioMcpServer,
} from './types'

export type McpSettingsManager = Pick<
  McpClientManager,
  | 'register'
  | 'connect'
  | 'reconnect'
  | 'disconnect'
  | 'remove'
  | 'get'
  | 'list'
  | 'subscribe'
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
  /** 用户确认了「在本机执行这条命令行」：落进配置，然后继续当初被拦下的那一步（H2）。 */
  approveLaunch(id: string): Promise<void>
  /** 用户选择暂不执行：撤掉请求，配置照留，不起任何进程。 */
  dismissLaunch(id: string): void
  /**
   * 进程内那份工具名缓存的只读出口（B5 的取数口）——B4 的未连接工具探针与 F4 的 manifest
   * 清单都从这里取数，因此它必须和写入点是同一份快照，不能是另一份拷贝。
   */
  readToolNameCache(): McpToolNameCache
  /**
   * 这个服务此刻是否已连接，以 manager 的登记表为准（不是界面 atom，也不是缓存）。
   * B4 的探针拿它来闭嘴：已连接的服务一律以真实工具清单为准。
   */
  isServerConnected(id: string): boolean
  dispose(): void
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

  // 同一个服务上的命令怎么串起来见 serverOperationQueue.ts。
  const enqueueServerOperation = createMcpServerOperationQueue()

  // 运行态写进 UI atoms 的那一层（含错误文案归一化）见 runtimeWriters.ts。
  const { setOperation, setRuntime, applySnapshot, applySnapshots } =
    createMcpRuntimeWriters(store)

  const configById = (id: string): PersistedMcpServerConfig | undefined =>
    store.getter(mcpServerConfigsAtom).find((config) => config.id === id)

  // 工具名清单缓存【进程内那一份】：安装探测（B2）与连接成功刷新（B3）共用它写入，
  // 服务删除时的级联清理（A2）共用它移除，B4/F4 的探针与设置面板共用它读出。为什么
  // 必须是同一份而不是各造一个，见 toolNameCacheWriter.ts；读写都留在 app 层，
  // tools/mcp 与 core 都不碰磁盘。
  const toolNameCache = createMcpToolNameCacheHandle(toolNameCacheStorage)
  // 缓存 → 设置面板 atom 的只读投影（B5）见 toolNameCacheProjection.ts。写入/删除点
  // 统一从投影发下去，调用方都不需要记得刷新界面。
  const toolNameCacheView = createMcpToolNameCacheProjection({
    store,
    cache: toolNameCache,
    isActive: () => !disposed,
  })
  const writeToolNameCache = toolNameCacheView.write
  const removeToolNameCache = toolNameCacheView.remove

  // 连上之后工具集还会变（MCP 的 tools/list_changed 就是为此），缓存不能停在安装那一刻。
  // 哪些快照才值得落盘、为什么断开绝不清缓存，都在 refreshOnConnect.ts；这里只补上
  // 「这个服务还算不算数」的判断。
  const refreshCacheOnConnected = createMcpConnectedCacheRefresher({
    write: writeToolNameCache,
    shouldRefresh: (id) => !disposed && configById(id) !== undefined,
  })

  const ensureSubscription = (): void => {
    if (unsubscribe || disposed) return
    unsubscribe = manager.subscribe((snapshots) => {
      if (disposed) return
      applySnapshots(snapshots)
      // 不 await：落盘走 IPC，界面状态不该等它。
      void refreshCacheOnConnected.observe(snapshots)
    })
  }

  // 配置怎么变成 manager 上的一次登记 / 连接，以及传输能力与起进程确认这两道准入判据，
  // 都在 serverConnector.ts；这里只决定【什么时候】登记、什么时候连。
  const connector = createMcpServerConnector({
    manager,
    writers: { setOperation, setRuntime, applySnapshot, applySnapshots },
    capabilities,
    isConfigured: (id) => configById(id) !== undefined,
  })

  // 配置的原子读-改-写（含它为什么必须跨 serverId 串行）见 configWriteQueue.ts。
  const persist = createMcpConfigWriteQueue({ store, storage })

  // 安装即探测（B2）。探测本身是一块独立逻辑，放在 probeOnInstall.ts；这里只把它接到
  // service 已有的三样东西上：按 serverId 的串行队列、用户可见的状态行、以及「这个服务
  // 是否还在（没被删、service 没 dispose）」的判断。
  const prober = createMcpInstallProber({
    manager,
    writeCache: writeToolNameCache,
    runExclusive: enqueueServerOperation,
    report: (text) => {
      if (!disposed) store.setter(mcpImportStatusAtom, text)
    },
    shouldProbe: (id) => !disposed && configById(id) !== undefined,
  })

  // 起进程前的确认（H2）。队列、落配置、以及「确认的是当时摆出来的那条命令行」这些
  // 纪律都在 launchConsentController.ts；service 这边只在每个会真的起进程的路口调一次
  // mayLaunchMcpServer，把没过门的 stdio 换成一条待确认请求。
  const launchConsent = createMcpLaunchConsentController({
    store,
    persist,
    configById,
    reportError: (id, message) => setRuntime(id, 'error', 0, message),
  })

  /**
   * 需要先问一次吗：桌面端的 stdio + 命令行还没被确认过。
   *
   * 浏览器里不问——那里根本没有 stdio 连接器（配置可以存，连不了），弹一个永远不会
   * 发生的执行确认只是噪音。
   */
  const needsLaunchConsent = (
    config: PersistedMcpServerConfig,
  ): config is PersistedStdioMcpServer =>
    capabilities.stdio && config.transport === 'stdio' && !mayLaunchMcpServer(config)

  /** 确认通过后补做那一次连接；确认动作发生在任何队列槽位之外，所以自己排队。 */
  const connectAfterConsent = (reconnect: boolean) =>
    (config: PersistedMcpServerConfig): Promise<void> =>
      enqueueServerOperation(config.id, () => connector.connect(config, { reconnect }))

  /**
   * 安装后的第一次真实动作：勾了自动连接就连上并复用这条连接的工具清单，否则只探测一次。
   *
   * 未确认的 stdio 走到这里只会拿到 prober 的 deferred（isInstallProbeSupported 直接拦下，
   * 不碰 manager.connect），确认之后原样再跑一次就是真的探测。
   */
  const runInstallProbe = async (config: PersistedMcpServerConfig): Promise<void> => {
    if (config.autoConnect && mayLaunchMcpServer(config)) {
      // 勾了自动连接的服务本来就要连——复用这一次连接的结果，不再为探测多连一次
      // （对同一个 id 连第二次会先关掉第一条连接，纯属浪费和噪音）。
      await enqueueServerOperation(config.id, async () => {
        await connector.connect(config, { reconnect: false })
        // 已经持有该 serverId 的串行槽位，recordConnected 按约定不再自己排队。
        await prober.recordConnected(config)
      })
      return
    }
    await prober.probeInstalled(config)
  }

  const hydrate = (): Promise<void> => {
    if (hydratePromise) return hydratePromise
    let succeeded = false
    const attempt = (async () => {
      store.setter(mcpHydrationAtom, { status: 'loading' })
      try {
        // 冷启动把工具名缓存读进进程内那份快照（B5）：不读，设置面板的「上次可用工具 N 个」、
        // B4 的未连接工具探针、F4 的 manifest 清单在「配置过但本次还没探测过」的服务上就全是空。
        // 与配置【并行】读、到 ready 之前才收口（两份数据互不依赖）；它绝不 reject，读不回来
        // 只是这一轮没有历史可显示，不影响冷启动成败。
        const toolNameCacheLoaded = toolNameCacheView.load()
        const configs = await storage.load()
        if (configs.length > MCP_SETTINGS_MAX_SERVERS) {
          throw new Error(`MCP 服务最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`)
        }
        // H1：stdio 的 autoConnect 现在是普通持久化字段，读回来是什么就是什么——
        // 不再把 true 悄悄改写成 false 再回写磁盘。是否连接是下面的运行行为决定，
        // 不该反过来篡改用户保存过的偏好。
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
        // 冷启动先把配置里的【全部】服务登记进 manager，再连该连的那批。
        // connect_mcp_server 的准入判据是 manager 的登记表，而记录过去只在连过一次之后
        // 才存在——不登记的话，「已配置但从未连过」的服务对模型根本不存在，按需连接形同虚设。
        await Promise.all(configs.map((config) =>
          enqueueServerOperation(config.id, () => connector.register(config))))
        // 冷启动自动连接的判据是【用户存过的偏好 + 这条命令行被确认过】，不再按
        // transport 一刀切（H1 之后 stdio 的 autoConnect 是正常字段，H2 之前那道
        // 「只连 streamable-http」的临时门就是在替确认把关）。stdio 的确认由
        // mayLaunchMcpServer 判定：确认过就照常自动连，没确认过（或确认已被命令改动
        // 作废）就停在未连接。
        //
        // 冷启动【不】在这里排确认请求：这一刻用户不一定在场，也没做任何动作，攒出
        // 一堆「要执行 X 吗」只会让人乱点。要连的话，卡片上点一次「重连」就会问。
        await Promise.all(
          configs
            .filter((config) => config.autoConnect && mayLaunchMcpServer(config))
            .map((config) =>
              enqueueServerOperation(config.id, () =>
                connector.connect(config, { reconnect: false }))),
        )
        await toolNameCacheLoaded
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

  // 表单提交与 JSON 导入这条「草稿 → 已保存的服务」的路见 installFlow.ts；它需要的
  // 三件运行期能力（接订阅、跑首次探测、排起进程确认）由这里注入。
  const installFlow = createMcpInstallFlow({
    store,
    persist,
    prober,
    capabilities,
    createId,
    setRuntime,
    ensureSubscription,
    runInstallProbe,
    requestInstallConsent: (config) => {
      if (needsLaunchConsent(config)) {
        launchConsent.request(config, 'install', runInstallProbe)
      }
    },
  })

  return {
    hydrate,
    submitDraft: installFlow.submitDraft,
    importJson: installFlow.importJson,
    async reconnect(id) {
      await enqueueServerOperation(id, async () => {
        const config = configById(id)
        if (!config) return
        // 「重连」是本机第一次执行这条命令的常见入口（安装时用户点了暂不、或者服务是
        // 早于 H2 存下来的）。先把命令行摆出来，确认后再连；只排队，不在这个槽位里连。
        if (needsLaunchConsent(config)) {
          launchConsent.request(config, 'connect', connectAfterConsent(true))
          return
        }
        await connector.connect(config, { reconnect: true })
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
          // 只有 manager.remove 与落盘都成功才级联清工具名缓存（A2）：任一步失败时
          // 配置/连接都还留着，缓存也不该跟着凭空消失——留着它下次还能当「上次已知」看。
          await removeToolNameCache(id)
          // 服务没了，它那条待确认请求也不该还挂在界面上。
          launchConsent.dismiss(id)
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
        try {
          const next = await persist((current) => current.map((entry) =>
            entry.id === id ? { ...entry, autoConnect: enabled } : entry,
          ))
          const updated = next.find((entry) => entry.id === id)
          if (!updated) return
          if (enabled) {
            // 开关只是【偏好】，它自己不构成执行授权：未确认的 stdio 把偏好照常存下来
            // （H1 的数据模型），但这一刻不起进程，改成问一次。用户点确认后连上，此后
            // 冷启动就凭这条偏好 + 已落配置的确认自动连，不再问第二次。
            if (needsLaunchConsent(updated)) {
              launchConsent.request(updated, 'auto-connect', connectAfterConsent(false))
              return
            }
            await connector.connect(updated, { reconnect: false })
          } else {
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
    approveLaunch(id) {
      return launchConsent.approve(id)
    },
    dismissLaunch(id) {
      launchConsent.dismiss(id)
    },
    readToolNameCache: toolNameCache.read,
    isServerConnected(id) {
      return manager.get(id)?.status === 'connected'
    },
    dispose() {
      disposed = true
      unsubscribe?.()
      unsubscribe = undefined
      // 这个 service 已经不再执行任何东西了，它排出去的确认请求也不能再被点。
      launchConsent.reset()
    },
  }
}
