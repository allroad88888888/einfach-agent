// 把当前宿主的命令桥登记进 core —— 三态里只有前两态有桥，`static` 什么都不登记。
// ---------------------------------------------------------------------------
// 【H5】生产代码里全仓只有这一处登记。core 侧的 13 个 runtime 模块
// （workspaceRead/Write/Patch/Delete/PathOperation/Rg/Git/Change/Task、shellCommand、
// projectSkillsBridge、userSkillsRoot、modelTurnPrefix）都不再问「是不是 Tauri」，只问
// 「宿主登记过桥没有」（packages/agent-core/src/runtime/hostBridge.ts）。少了这一句，本机的
// 文件 / shell / Git / rg 工具会整类对模型不可见（modelTurnPrefix 的 hostHasLocalCapabilities
// 就是 hasHostBridge()），执行也一律早退。
//
// 【为什么调用它是装配序列的第一步】它必须早于任何工具可能执行的时点，而那个时点比首屏渲染早：
//   · 先于 bootstrapApplication() 里的 core.persistence.hydrate()——恢复出来的会话可能带着
//     未完成的 run，那是工具真正可能执行的第一个时点；
//   · 先于 initializePluginSettings()——desktopProvider 的 resolveBridge() 会求值一次
//     buildProjectSkillsWorkspaceBridge() 并把结果 `??=` 缓存住，那一刻没有桥的话，缓存下来的
//     undefined 会让插件面在整个进程生命周期里都报「当前宿主没有 workspace 文件系统通路」，
//     而且不会自愈；
//   · 也先于首屏渲染与 MCP 的 autoConnect。
// 登记本身是同步的（收的是 loader 而不是已解析的 invoke，理由见 hostBridge.ts 的 JSDoc），
// 所以不存在「已登记但 hasHostBridge() 还答 false」的窗口。**异步的是它上游的宿主解析**：
// server 宿主要先握手才知道自己是 server、平台是什么，所以装配层的形状是「先 await
// resolveHost()，再登记，再 bootstrap」，不能让这两件事并行发起。
//
// 【为什么不用 core 的 loadTauriInvoke()】它没有出现在 @einfach-agent/core 的公开面上，深导入
// `@einfach-agent/core/runtime/hostTauri` 会撞 check-boundaries 的 core 公开面白名单（S9）。
// 装配层自己持有这个 loader 也更贴 H 线的方向：桥背后是什么由宿主说了算，core 不必认识 Tauri。
//
// 【为什么 static 不登记】静态产物没有后端，登记等于骗 core 说有本机能力，模型会看到一堆
// 调用即失败的工具。浏览器要拿到本机能力，路径是起 `apps/server`（那就成了 server 宿主），
// 不是给 static 发一张空头支票。
//
// 【S5】登记桥时必须一并声明宿主平台，两者是同一次登记的两半（hostBridge.ts 的
// HostBridgeRegistration）。**两态的平台来源不同，不能互抄**：桌面端 webview 与原生跑在同一台
// 机器上，`navigator.userAgent` 说什么、执行 shell 的就是那台机器，所以用本地探测；
// server 宿主上这条前提不成立（用户 macOS、服务端 Linux），平台只能取自 `GET /api/health` 的
// 握手（resolveHost 已把它带在 `kind: 'server'` 这一支上，类型上漏不掉）。
// 握手报回 `'unsupported'`（FreeBSD / AIX 这类）时原样传下去：core 认识第四个值，
// 在这里替它映射成三选一等于谎报，而后果是每条 shell 命令都撞 platform mismatch。
import { invoke } from '@tauri-apps/api/core'
import { configureHostInvoke, detectLocalPlatform } from '@einfach-agent/core'
import type { ResolvedHost } from './resolveHost'
import { httpInvoke } from './serverInvoke'
import { getServerInvokeToken } from './serverInvokeToken'

/**
 * 按解析出的宿主登记命令桥。
 *
 * loader 的类型是 `() => Promise<HostInvoke>`——两态都得包一层函数，直接把 invoke 本体传进去
 * 编译不过。Tauri 那支写成 `() => Promise.resolve(invoke)` 而不是 `() => import(...)`：
 * `resolveHost.ts` 已经静态引了同一个说明符（`isTauri`），动态形式在这里换不来任何惰性
 * （模块早在静态图里），只会给 Rollup 那条既有的
 * 「dynamic import will not move module into another chunk」告警再添一个源头。
 */
export function registerHostCommandBridge(host: ResolvedHost): void {
  switch (host.kind) {
    case 'tauri':
      configureHostInvoke({ loader: () => Promise.resolve(invoke), platform: detectLocalPlatform() })
      return
    case 'server':
      // **必须在这里就把 token 收下来，不能等第一条请求。**
      // `getServerInvokeToken()` 顺带做的事是「读走 query 里的 token → 存 sessionStorage →
      // `history.replaceState` 把 token 从地址栏抹掉」，而它原本只在 serverInvoke 的请求路径上
      // 被调用。于是「用户打开页面但一条命令都还没跑」的整段时间里，token 一直留在地址栏——
      // 进浏览器历史、进截图、页面若外链还会进 Referer，而这恰恰是抹它的全部理由。
      // 单元测试看不见这条：它们直接调 getServerInvokeToken()，天然"调用过了"。
      // 由主会话 B4 在真实浏览器里发现（页面加载完 URL 里 token 仍在、sessionStorage 为空）。
      getServerInvokeToken()
      configureHostInvoke({ loader: async () => httpInvoke, platform: host.platform })
      return
    case 'static':
      return
  }
}
