import { uiStore } from '../uiStore'
import { defaultCore, configureCommands } from '@einfach-agent/core'
import {
  createMcpClientManager,
  createMcpConnectorRouter,
  createMcpConnectTargetProbe,
  createMcpPlaceholderClaims,
  createStreamableHttpMcpConnector,
} from '@einfach-agent/tools-mcp'
import {
  configureMcpSettings,
  isMcpServerConnected,
  isMcpSettingsConfigured,
  readMcpToolNameCache,
} from './commands'
import { mcpServerConfigsAtom } from './state'
import { mayLaunchMcpServer, stdioCommandLine } from './stdioLaunchConsent'
import { createBrowserMcpConfigStorage, type McpConfigStorage } from './persistence'
import { createServerMcpConfigStorage } from './serverMcpConfigStorage'
import { createServerStdioMcpConnector } from './serverStdioConnector'
import { createToolNameCacheStorageForHost } from './toolNameCacheStorage'
import type { ResolvedHost } from '../host/resolveHost'
import { wireMcpToolProbes } from './toolProbeWiring'

/**
 * 模型发起的连接要不要先问一次（F8）：这条命令行用户确认过吗。
 *
 * 【为什么这个判断只能在这里做】起进程确认记在持久化配置的 launchConsent 指纹上，那是
 *   app 层的东西；而探针在 tools/mcp 层只看得到 manager 登记表里的连接字段。装配点是唯一
 *   同时拿得到两样东西的地方，所以事实在这里注入，判定仍然只有 mayLaunchMcpServer 一处。
 *
 * 【为什么还要比一次命令行】用户批准的是「在我的机器上执行这一条」。真正会被执行的是
 *   manager 登记表里那一条（连接工具走 manager.reconnect）。两者对不上就说明确认覆盖的
 *   不是这次要跑的命令 —— 当作没确认过。
 *
 * 任何一步答不上来都返回 false：宁可多问一次，不能静默起一次进程。
 */
function isMcpLaunchConsented(serverId: string, commandLine: string): boolean {
  const config = uiStore.getter(mcpServerConfigsAtom).find((entry) => entry.id === serverId)
  if (!config || config.transport !== 'stdio') return false
  if (stdioCommandLine(config) !== commandLine) return false
  return mayLaunchMcpServer(config)
}

/**
 * 服务配置落在哪：两态各走各的通道，判据只有递进来的这一个 `host`。
 *
 * 【为什么是显式分支，而不是让存储工厂自己探一次宿主】（C7）工厂内部再探一次的后果不是报错，
 * 是两处结论不同时静默走岔：一份状态落进 `~/.webAgent/config.json`、另一份落进浏览器
 * localStorage，两边都不吭声。宿主态的唯一权威是 `resolveHost()`，装配点按它一次分派到底。
 */
function createConfigStorageForHost(host: ResolvedHost): McpConfigStorage {
  switch (host.kind) {
    case 'server':
      return createServerMcpConfigStorage()
    case 'static':
      return createBrowserMcpConfigStorage()
  }
}

/**
 * Installs the application MCP manager when the settings UI first needs it.
 *
 * 【为什么收 host 而不是自己探一次】宿主态的唯一权威是 `resolveHost()`——server 宿主要经
 * `GET /api/health` 握手才认得出来，本地探测答不了。再探一次的后果不是报错，是两处结论不同时
 * 静默走岔：连接器判定「没有本机能力」不给 stdio，而配置存储按别的判据去写本机配置文件。
 *
 * 【这条纪律管到叶子】（C7）「装配点不自己探」不等于「装配点调的东西不自己探」。服务配置与
 * 工具名缓存这两份状态必须落到同一处，而它们此前各由一个内部自探宿主的工厂选通道——
 * server 宿主下前者进 `~/.webAgent/config.json`、后者进浏览器 localStorage，分家且不报错。
 * 现在两者都由本函数按同一个 `host` 分派，全流程只剩 `resolveHost()` 一处探测。
 */
export function initializeMcpSettings(host: ResolvedHost): void {
  if (isMcpSettingsConfigured()) return

  const serverHost = host.kind === 'server'
  // stdio 只有 server 这一态有连接器（经 `POST /api/invoke/mcp_*` + 一条共享 SSE）：
  // static 宿主背后没有能起子进程的机器，不给这个键。
  const connector = createMcpConnectorRouter({
    'streamable-http': createStreamableHttpMcpConnector(),
    ...(serverHost ? { stdio: createServerStdioMcpConnector() } : {}),
  })
  // 占位登记表（D2/D2a）：manager 的 reconcile 与占位同步器必须共用【同一个实例】——
  // reconcile 靠它放行「本服务占位正占着这个名字」，两边各造一份的话，每个有缓存清单的
  // 服务一连接就会抛工具名冲突。所以它在这里创建，两边都从这里拿。
  const placeholderClaims = createMcpPlaceholderClaims()
  const manager = createMcpClientManager({
    registry: defaultCore.tools,
    connector,
    placeholders: placeholderClaims,
  })
  // 同一个理由的第二根线：连接工具的风险要按目标服务分级（stdio 会在本机起子进程 → 需确认；
  // HTTP 只发网络请求 → 放行），而 core 不能反向依赖本包去查 transport。这里把 mcp 域的探针接进
  // 运行时配置；不接这根线时 core 会把每次连接都当危险处理（从严），不会静默放行。
  // 探针另外带上「这条启动命令确认过没有」（F8）：没确认过的 stdio 连接在 Auto 模式下也要暂停。
  // 这一个探针实例同时服务两条路径：模型调 connect_mcp_server（F8），以及模型直接调用某个
  // 未连接服务的占位工具（D3a，见 wireMcpToolProbes 的 connectTarget）。同一个服务、同一条
  // 命令行、同一份确认记录，换一条触发路径不该换一套事实。
  const connectTarget = createMcpConnectTargetProbe(manager, {
    isLaunchConsented: isMcpLaunchConsented,
  })
  configureCommands({ mcpConnectTarget: connectTarget })
  // 占位同步器要等 manager 装好才造得出来，而 service 在下一行就已经建好——所以递给它的是
  // 一个【调用当刻才解析】的闭包，而不是同步器本身。缓存的每次写入/删除/冷启动读盘都经
  // 投影的 publish 汇合成这一次调用（见 toolNameCacheProjection.ts）。
  let syncPlaceholders: (() => void) | undefined
  configureMcpSettings({
    manager,
    storage: createConfigStorageForHost(host),
    // 工具名缓存与上面那份服务配置**同源同宿主**（C7）：同一个 `host` 决定两者，落在同一处。
    toolNameCacheStorage: createToolNameCacheStorageForHost(host),
    onToolNameCacheChanged: () => syncPlaceholders?.(),
    // 这两个 flag 回答的是两个不同问题（C3，见 types.ts 的 McpSettingsCapabilities 注释）：
    // 能不能在本机起子进程 / 凭据能不能落盘。它们**恰好**在 server 宿主上同时为真，不是同一件事——
    // server 宿主能起子进程是因为本机 Node 后端替它 spawn；凭据能落盘是因为那个后端读写的正是
    // 同一份 `~/.webAgent/config.json`（host-node 的 config 域）。static 宿主两者皆无。
    // 分开写而不是共用一个布尔：将来任一维度先动，改的是这里的一半，不是把两件事一起翻。
    capabilities: { stdio: serverHost, credentials: serverHost },
  })
  // mcp 域工具需要注入这个进程级 manager —— 装配点就是唯一能同时拿到 registry 与 manager 的地方。
  // 顺带把工具名缓存喂给模型看得见的那两处（B5，规矩见 toolProbeWiring.ts）：两个读出口都从
  // commands.ts 走，因此 configureMcpSettings 之后换掉的 service 也能被这两根线读到。
  // 缓存本身在 hydrateMcpSettings() 里从磁盘读进来（main.tsx 启动时就调）。
  // 第三根线（D2）：未连接服务的缓存清单以占位工具的形式进 ToolRegistry。
  // 第四根线（D3a）：占位调用会不会顺带在本机起进程——与占位注册同处接线，同进同退。
  const wiring = wireMcpToolProbes({
    registry: defaultCore.tools,
    manager,
    claims: placeholderClaims,
    connectTarget,
    getCache: readMcpToolNameCache,
    isConnected: isMcpServerConnected,
    configure: configureCommands,
  })
  // 同步器在创建时已经对过一次账，但装配这一刻缓存还没读盘（hydrateMcpSettings 才读），
  // 所以那一次必然算不出任何占位。真正装上占位的是冷启动读盘完成后经上面那个闭包回来的
  // 这一次重算——以及此后每一次缓存写入/删除。
  syncPlaceholders = wiring.syncPlaceholders
}
