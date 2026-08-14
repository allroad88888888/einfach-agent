// apps/web/src/mcp/toolLaunchTargetProbe.ts —— 把一次 `mcp__<服务>__<工具>` 调用翻译成 core 做
// 起进程分级时唯一需要的那条事实：这次调用会不会在本机拉起进程（D3a）。
//
// 【为什么合成在这一层】答这条事实要同时握住三样东西：占位登记表（tools-mcp 的对象，由本层
//   持有并分发）、服务的落地方式与起进程确认记录（既有的 connectTarget 探针，确认记录是 app
//   层的 launchConsent 指纹）、以及此刻的连接状态。core 不能反向依赖其中任何一边，所以合成只
//   能发生在装配点。切法与 F3/B4 两根既有探针完全一致：core 定策略，宿主给事实。
//
// 【为什么「注册名 → serverId」只认占位登记表，不用缓存反查】
//   1. 语义同源：会起进程的唯一路径是「调用命中了某服务的【占位】→ 透明连接」。登记表记的正是
//      「registry 里这个名字现在是哪个服务的占位」，与将要发生的事一一对应；缓存回答的是另一个
//      问题（这个名字上次已知出自谁），它可以与 registry 的当前注册状态不一致。探针答题的时机
//      是模型正要调用一个【已注册】的工具，问的就是「现在注册着的这一份是什么」。
//   2. 不会摆错命令行：跨服务撞名时先到先得，缓存反查却可能答出被跳过的那个服务，于是确认卡片
//      摆出一条根本不会被执行的命令——用户批准的必须是将要跑的那一条，这是安全 UI 的硬伤。
//   3. 顺带把「已连接」答对：连接成功时 reconcile 用真实工具覆盖同名占位并释放登记，于是已连接
//      服务的普通调用天然查不到登记 → undefined → 维持既有的 dangerous，零回归。
//
// 【为什么还要再问一次 isConnected】纵深防御。登记表与 manager 状态若因某个 bug 不同步（占位
//   没被释放干净），仍然不该让一个已连上的服务的普通调用在 Auto 模式下停下来问——那是回归。
//   两道判断的方向一致（都只会让答案更接近 undefined），所以叠加不会把「该问的」问掉。
import type {
  McpConnectTargetProbe,
  McpToolLaunchTargetProbe,
} from '@web-agent/core/tools'
import type { McpPlaceholderClaims } from '@web-agent/tools-mcp'

export interface McpToolLaunchTargetProbeSource {
  /** 占位登记表：注册名 → 现在占着它的那个占位归谁。必须是装配期那【同一个实例】。 */
  claims: Pick<McpPlaceholderClaims, 'get'>
  /** serverId → 落地方式与起进程确认状态（既有的 createMcpConnectTargetProbe 产物）。 */
  connectTarget: McpConnectTargetProbe
  /** serverId → 此刻是否已连接（以 manager 登记表为准）。 */
  isConnected(serverId: string): boolean
}

/**
 * 造一个绑定到给定占位登记表与连接目标探针的「这次调用会不会起进程」探针。
 *
 * 装配点（toolProbeWiring.ts，与占位注册同一处）用它接进 RuntimeConfig.mcpToolLaunchTarget。
 * 只递事实、不递决策：`spawnsLocalProcess` / `command` / `launchConsented` 原样来自既有探针，
 * 「要不要暂停」由 core 的 classifyToolRisk 一处决定。
 */
export function createMcpToolLaunchTargetProbe(
  source: McpToolLaunchTargetProbeSource,
): McpToolLaunchTargetProbe {
  if (
    typeof source?.claims?.get !== 'function'
    || typeof source?.connectTarget !== 'function'
    || typeof source?.isConnected !== 'function'
  ) {
    throw new Error('createMcpToolLaunchTargetProbe requires claims, connectTarget and isConnected')
  }
  return (toolName) => {
    // 不是占位 = 这次调用要么打在真实工具上（服务已连着），要么根本不存在这个工具。
    // 两种情况都不会起进程。
    const serverId = source.claims.get(toolName)?.serverId
    if (!serverId) return undefined
    if (source.isConnected(serverId)) return undefined
    return source.connectTarget(serverId)
  }
}
