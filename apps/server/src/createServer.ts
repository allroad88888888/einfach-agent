// 装配：把选项拼成一台 `http.Server`。
//
// 【HTTP 栈选型：Node 内置 `node:http`，不引 express / fastify】
// 这台服务器的全部职责是「一条 health + 一份静态产物 + 一张已经存在的命令路由表（S3）」——
// 没有中间件生态、没有路由参数、没有模板引擎要接。框架能省下的那几十行分派代码，换来的是一条
// 常驻的供应链面，而这个进程随后要经 `/api/invoke` 执行 shell 命令与读写文件，它的依赖树里
// 每多一个包都是同一份权限的分享者。仓库里也已有先例：`scripts/model-preview-relay.ts` 同样
// 直接操作 `IncomingMessage` / `ServerResponse`。
//
// 本模块**不 listen**：端口选择、被占换端口、URL 打印归 S4。绑定地址的默认值是
// `authLoopback.ts` 的 `DEFAULT_BIND_ADDRESS`（`127.0.0.1`），S4 在 `listen` 那一步取用。
// 返回一台没在监听的 server，测试才能自由地 `listen(0)`，两张卡也各自改各自的那一层。
//
// **绑定地址是默认值，不是执行**：即便将来某个 `--host` 选项把它绑到 `0.0.0.0`，`/api/*` 仍然只对
// 回环开放——`authGuard.ts` 在每条请求上重新判一次对端地址。会被暴露出去的只有静态产物，
// 那是用户自己 build 的公开文件。安全性不建立在「S4 记得传对地址」上。

import { existsSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHostEventBus, createNodeHostInvoke, nodeHostPlatform } from '@web-agent/host-node'
import { generateAuthToken } from './authToken'
import { createEventsRouteHandler } from './eventsRoute'
import { createInvokeRouteHandler } from './invokeRoute'
import { createModelRouteHandler } from './modelRoute'
import { resolveServerVersion } from './packageVersion'
import { createRequestRouter } from './requestRouter'

// 【D1：默认前端产物目录，开发形态与分发形态都要对】
// 本文件所在目录 `dirname(import.meta.url)` 在两种形态下指向不同的地方，但恰好都能用来找到
// 正确的产物：
// - **开发形态**：`pnpm serve` 用 tsx 直接跑 `apps/server/src/createServer.ts`（未打包），
//   `here` = `apps/server/src`。这里没有内嵌产物，探测落空，回落到仓库路径
//   `apps/server/src/../../web/dist` = `apps/web/dist`（vite build 的产出）。
// - **分发形态**：`apps/server` 经 tsup 打包成单文件 `apps/server/dist/main.js`
//   （构建收尾见 `scripts/embed-web-dist.mjs`，把 `apps/web/dist` 复制成同级的
//   `apps/server/dist/public`）。esbuild 打包后所有内联模块共享同一个 `import.meta.url`
//   ——就是这份产物自己的 URL——所以此时 `here` = `apps/server/dist`（不论这份 dist 躺在
//   仓库里还是被 `npm pack` 安装进了别处的 `node_modules/@web-agent/server/dist`）。
//   `here/public` 存在，直接用它，**不落到仓库路径**（那条路径在装进 node_modules 后并不存在，
//   即便存在也可能是过期的另一次 build）。
//
// 两条探测都是**运行期检查是否存在**，不是「猜哪种形态」；顺序上先试分发路径再落回开发路径，
// 因为分发路径只可能在真正内嵌过产物时才存在，不会误判。
//
// **不要写成 `new URL('字面量', import.meta.url)`**：Vite 认得这个字面量形态并会把它当成资源
// 引用静态改写掉（assetImportMetaUrl），于是 Vitest 下拿到的根本不是 file: URL，
// `fileURLToPath` 当场抛 “The URL must be of scheme file”。先落到路径再拼，不碰那个模式。
function resolveDefaultDistDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const packaged = resolve(here, 'public')
  if (existsSync(packaged)) return packaged
  return resolve(here, '../../web/dist')
}

export const DEFAULT_DIST_DIRECTORY = resolveDefaultDistDirectory()

export interface WebAgentServerOptions {
  /** 前端构建产物目录，默认指向仓库里的 `apps/web/dist`。 */
  readonly distDirectory?: string
  /** health 回报的版本号，默认取本包 package.json 的 version。 */
  readonly version?: string
  /**
   * `/api/*` 的访问令牌。**S4 应当自己 `generateAuthToken()`，把同一个值同时喂给这里和它打印的
   * URL**——token 只活在这两处，没有第三个副本（不落盘、不进配置、不进日志）。
   *
   * 不传时本函数仍会生成一枚随机 token，**这不是「关闭认证」**：没有任何客户端知道那个值，
   * 于是每条 `/api/*` 请求都会 401。这是刻意的——默认必须安全，而「忘了传」的后果应当是
   * 全部 401 这种一眼可见的响亮失败，不是静默放行。本模块因此没有 `disableAuth` 这类开关。
   */
  readonly token?: string
  /**
   * 主目录，透传给 host-node 的装配槽（`get_user_home_dir` 与用户级 Skills 目录用它）。
   * 不传时 host-node 回落到 `os.homedir()`。
   */
  readonly homeDir?: string
  /**
   * 关停钩子的登记面，原样透传给 host-node 的 `registerHostDisposer` 槽。
   *
   * **不传是有后果的**：MCP 会话就只剩 host-node 那道 `process.on('exit')` 兜底，而 `SIGTERM`
   * 走默认处置时那道兜底根本不执行，子进程会活下来。S4（`mainRunServer.ts`）总是传，装载点在
   * `mainShutdown.ts`；这里留成可选是因为测试里起的 server 不该去碰进程级信号。
   */
  readonly registerHostDisposer?: (dispose: () => Promise<void>) => void
  /** 未预期异常的去处；默认写 stderr。 */
  readonly onInternalError?: (error: unknown) => void
}

export function createWebAgentServer(options: WebAgentServerOptions = {}): Server {
  // 命令路由表建一次、被闭包捕获：host-node 那边本来就把「重新登记」当作作废旧桥的信号，
  // 每条请求现搭一张表既浪费也会让装配槽的语义变得可变。
  // 事件汇（C2）建在命令表**之前**：C1 的 MCP 传输层要在建表那一刻拿到发射面。
  // 它只拿 `emitHostEvent`（发射面），拿不到订阅面——传输层能订阅自己发的事件就等于给
  // 「事件回环驱动状态」留口子。C3 的 SSE 端点拿的是另一半（`HostEventSource`）。
  // `onHandlerError` 与 `onInternalError` 形状相同（C2 刻意对齐的），直接传。
  const hostEvents = createHostEventBus({ onHandlerError: options.onInternalError })
  const invoke = createNodeHostInvoke({
    homeDir: options.homeDir,
    registerHostDisposer: options.registerHostDisposer,
    emitHostEvent: (event) => { hostEvents.emitHostEvent(event.name, event.payload) },
  })
  // 【S5：握手报的平台没有覆盖开关，这是有意的】
  // 这个值必须是**执行 shell 命令的那台机器**的答案，而 `nodeHostPlatform()` 正是上面这张路由表
  // 里 shell 域做 `platform mismatch` 判定时调的同一个函数（`packages/host-node`）。开一个
  // `options.platform` 就等于允许装配层报一个与实际执行机器不同的平台，那恰好是本卡要消灭的
  // 「把权威劈成两处」——客户端会照着假平台组命令，然后被真机器逐条拒绝。
  // 要测「浏览器在 macOS、服务端在 Linux」不能靠篡改这里，那个场景在 core 侧构造
  // （`packages/agent-core/src/runtime/hostPlatform.test.ts`）：本机探测答 macos、握手源答 linux。
  const router = createRequestRouter({
    distDirectory: options.distDirectory ?? DEFAULT_DIST_DIRECTORY,
    health: { version: options.version ?? resolveServerVersion(), platform: nodeHostPlatform() },
    auth: { token: options.token ?? generateAuthToken() },
    invokeRoute: createInvokeRouteHandler({ invoke }),
    modelRoute: createModelRouteHandler({ forward: { options: { homeDir: options.homeDir } } }),
    eventsRoute: createEventsRouteHandler({ events: hostEvents }),
    onInternalError: options.onInternalError,
  })
  // router 返回 Promise，而 `http.createServer` 的监听器是同步签名：这里显式 void 掉。
  // router 内部已经把所有异常收成 500，不会有逃逸的 rejection。
  return createHttpServer((request, response) => { void router(request, response) })
}
