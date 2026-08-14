// apps/web/src/mcp/toolProbeWiring.ts —— 把工具名缓存接到【模型看得见】的那两处（B5）。
//
// 按需连接模式要成立，模型必须能回答两个问题，而两个答案都只在这份缓存里：
//   1.「我要的能力在哪个还没连的服务上？」→ F4：未连接服务的清单进 connect_mcp_server 的描述。
//   2.「我直接点名调了一个缓存里的工具，为什么不认识？」→ B4：把 unknown tool 换成「请先连接」。
// 两根线各自的实现早就写好了（cachedToolProviderProbe.ts / tools-mcp 的 lastKnownTools.ts），
// 但不接上就都是死代码——它们没有任何自发的调用者。
//
// 【为什么两根线放在一个函数里】它们喂的是同一份缓存，且必须同进同退：只接 F4 而不接 B4，
// 模型就会看着清单点名调用、然后收到一句 unknown tool；只接 B4 而不接 F4，模型压根不知道
// 有哪些未连接服务值得连。分开接线 = 给「只接了一半」留后门。
//
// 【为什么单独成文件】这是纯装配：把宿主手里的四样东西（registry / manager / 缓存读出口 /
// 连接状态）按上面的规矩组起来。抽出来才有一个可以直接断言「线真的接上了」的单元——
// initialize.ts 那边还夹着 isTauri、连接器路由等一堆与本判据无关的东西。

// 【第三根线 · D2】未连接服务的缓存清单还要以【占位工具】的形式进 ToolRegistry：模型于是
// 在工具清单里直接看得见 mcp__<服务>__<工具>，而不是只在 connect_mcp_server 的描述里读到
// 一串名字。占位的形状与生命周期都在 tools-mcp（placeholderTool.ts / placeholderSync.ts），
// 这里只做同一件事——把宿主手里的 registry、manager、缓存读出口和占位登记表接起来。
//
// 【为什么占位也放这个函数】和上面两根线同理，而且更硬：占位与 B4 探针是同一份缓存的两种
// 呈现，只接一半就会自相矛盾（清单里看得见工具，点名调用却回一句 unknown tool）。

// 【第四根线 · D3a】占位一旦可被直接调用，一次普通的 mcp__* 调用就可能顺带在本机拉起进程
// （未连接的 stdio 服务会先透明连接）。风险判定要的那条事实（这次调用会不会起进程）在这里
// 合成，接进 RuntimeConfig.mcpToolLaunchTarget。
//
// 【为什么必须与占位注册同处接线】这是本次改动的安全前提，不是排版偏好：core 那侧的探针在
// 答不上来时【故意不从严】（否则已连接服务的每次调用都会在 Auto 模式下停下来问，属于回归），
// 于是「未确认的 stdio 不会被静默拉起」这条保证完全落在装配上——占位与探针同进同退，没有
// 占位就没有透明连接，接了占位就必然接了探针。谁把这两行拆到两个地方，谁就重新打开了那扇门。

import type {
  McpConnectTargetProbe,
  McpToolLaunchTargetProbe,
  UnconnectedToolProviderProbe,
  ToolRegistry,
} from '@web-agent/core/tools'
import {
  createMcpPlaceholderSync,
  registerMcpTools,
  type McpClientManager,
  type McpConnectManager,
  type McpPlaceholderClaims,
} from '@web-agent/tools-mcp'
import { createCachedToolProviderProbe } from './cachedToolProviderProbe'
import { createMcpToolLaunchTargetProbe } from './toolLaunchTargetProbe'
import {
  listLastKnownTools,
  readLastKnownTools,
  type McpToolNameCache,
} from './toolNameCache'

export interface McpToolProbeWiringOptions {
  registry: ToolRegistry
  /**
   * 连接工具只要 McpConnectManager 那三个方法（reconnect/get/list），占位同步器还要
   * list/subscribe 算 desired、并把 get/reconnect 转交给透明连接执行器（D3b）——
   * 交集就是这个类型。宿主递进来的本来就是同一个 manager 实例：显式连接与占位的透明连接
   * 必须走同一个连接状态机，否则单飞、退避与起进程确认会各算各的。
   */
  manager: McpConnectManager & Pick<McpClientManager, 'list' | 'subscribe'>
  /**
   * 占位登记表。必须与 createMcpClientManager 收到的是【同一个实例】：reconcile 靠它放行
   * 「本服务占位正占着这个名字」，两边各造一份的话，每个有缓存清单的服务一连接就抛工具名冲突。
   */
  claims: McpPlaceholderClaims
  /**
   * serverId → 落地方式与起进程确认状态。宿主递进来的是它接给 core 的【同一个】
   * mcpConnectTarget 探针实例：模型走 connect_mcp_server 和直接调用占位，问的是同一件事
   * （这个服务会不会在本机起进程、那条命令行确认过没有），不能各算各的。
   */
  connectTarget: McpConnectTargetProbe
  /**
   * 取当前那份工具名缓存。必须是进程内那一份的读出口（commands.ts 的 readMcpToolNameCache），
   * 不能是调用方自己攒的快照——那样两根线看到的会是各自不同的旧数据。
   */
  getCache(): McpToolNameCache
  /**
   * serverId → 此刻是否已连接。B4 立的硬约束：已连接的服务探针必须闭嘴，否则「缓存里有、
   * 连上后已下线」的工具会被答成「请先连接」，把模型推进连接死循环。
   */
  isConnected(serverId: string): boolean
  /** 把探针接进运行时配置；宿主传 core 的 configureCommands。 */
  configure(config: {
    unconnectedToolProvider: UnconnectedToolProviderProbe
    mcpToolLaunchTarget: McpToolLaunchTargetProbe
  }): void
}

export interface McpToolProbeWiring {
  /**
   * 立刻重算占位集合。manager 状态变化由同步器自己订阅，剩下三个时机由宿主调它：
   * 缓存写入/删除之后、冷启动读盘（hydrate）之后、以及服务被删除后的补算。
   */
  syncPlaceholders(): void
  /** 退订 manager。已注册的占位不清除——换 core 时由新的同步器接管。 */
  dispose(): void
}

/**
 * 注册 mcp 域工具（带上次已知清单）、把未连接工具探针与起进程事实探针接进运行时配置，
 * 并让未连接服务的缓存清单以占位工具的形式进 ToolRegistry。
 */
export function wireMcpToolProbes({
  registry,
  manager,
  claims,
  connectTarget,
  getCache,
  isConnected,
  configure,
}: McpToolProbeWiringOptions): McpToolProbeWiring {
  // F4：清单在【调用当刻】才从缓存取，所以探测/连接刷新写进缓存之后立刻生效，
  // 不需要重新 registerMcpTools。
  registerMcpTools(registry, {
    manager,
    lastKnownTools: () => listLastKnownTools(getCache()),
  })
  // B4：缓存条目名就是注册名（写入侧已经过一次 makeMcpToolName），模型点名用的也是它，
  // 所以这里只需把缓存和连接状态递进去，不再注入任何名字映射——再拼一次就是双重前缀。
  // D3a：起进程事实与 B4 探针同一次接进配置——同进同退是这条链路的安全前提（见文件头）。
  // 它认的是【占位登记表】而不是缓存：登记表说的是「registry 里这个名字现在归谁」，
  // 与「这次调用会不会先连接一个未连接的服务」一一对应（理由见 toolLaunchTargetProbe.ts）。
  configure({
    unconnectedToolProvider: createCachedToolProviderProbe({ getCache, isConnected }),
    mcpToolLaunchTarget: createMcpToolLaunchTargetProbe({ claims, connectTarget, isConnected }),
  })
  // D2：占位同步器。同样只递一个【调用当刻才取数】的只读函数，它不认识缓存住在哪。
  const placeholders = createMcpPlaceholderSync({
    registry,
    manager,
    claims,
    lastKnownTools: (serverId) => readLastKnownTools(getCache(), serverId),
    // 跨服务撞名（两个服务的缓存里出现同一个注册名）是先到先得、后者跳过，但不能静默——
    // 否则「某个工具怎么一直不出现在清单里」将完全无从查起。这里刻意【不】报「被真实工具
    // 占着」那一类跳过：那是正常状态（真实工具永远优先），报了只会在每次连接时刷屏。
    onSkip: ({ serverId, name, reason }) => {
      console.warn(`[mcp] 占位工具 ${name}（服务 ${serverId}）未注册：${reason}`)
    },
  })
  return {
    syncPlaceholders: placeholders.sync,
    dispose: placeholders.dispose,
  }
}
