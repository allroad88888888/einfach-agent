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

import { createServer as createHttpServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeHostInvoke } from '@web-agent/host-node'
import { generateAuthToken } from './authToken'
import { createInvokeRouteHandler } from './invokeRoute'
import { resolveServerVersion } from './packageVersion'
import { createRequestRouter } from './requestRouter'

// 相对本文件定位仓库里的前端产物：apps/server/src/ → apps/web/dist。
// 分发形态（npm 包里产物放哪儿）由 D 线决定，届时装配层显式传 `distDirectory` 覆盖。
//
// **不要写成 `new URL('../../web/dist', import.meta.url)`**：Vite 认得这个字面量形态并会把它
// 当成资源引用静态改写掉（assetImportMetaUrl），于是 Vitest 下拿到的根本不是 file: URL，
// `fileURLToPath` 当场抛 “The URL must be of scheme file”。先落到路径再拼，不碰那个模式。
export const DEFAULT_DIST_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

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
  /** 未预期异常的去处；默认写 stderr。 */
  readonly onInternalError?: (error: unknown) => void
}

export function createWebAgentServer(options: WebAgentServerOptions = {}): Server {
  // 命令路由表建一次、被闭包捕获：host-node 那边本来就把「重新登记」当作作废旧桥的信号，
  // 每条请求现搭一张表既浪费也会让装配槽的语义变得可变。
  const invoke = createNodeHostInvoke({ homeDir: options.homeDir })
  const router = createRequestRouter({
    distDirectory: options.distDirectory ?? DEFAULT_DIST_DIRECTORY,
    health: { version: options.version ?? resolveServerVersion() },
    auth: { token: options.token ?? generateAuthToken() },
    invokeRoute: createInvokeRouteHandler({ invoke }),
    onInternalError: options.onInternalError,
  })
  // router 返回 Promise，而 `http.createServer` 的监听器是同步签名：这里显式 void 掉。
  // router 内部已经把所有异常收成 500，不会有逃逸的 rejection。
  return createHttpServer((request, response) => { void router(request, response) })
}
