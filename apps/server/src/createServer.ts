// 装配：把选项拼成一台 `http.Server`。
//
// 【HTTP 栈选型：Node 内置 `node:http`，不引 express / fastify】
// 这台服务器的全部职责是「一条 health + 一份静态产物 + 一张已经存在的命令路由表（S3）」——
// 没有中间件生态、没有路由参数、没有模板引擎要接。框架能省下的那几十行分派代码，换来的是一条
// 常驻的供应链面，而这个进程随后要经 `/api/invoke` 执行 shell 命令与读写文件，它的依赖树里
// 每多一个包都是同一份权限的分享者。仓库里也已有先例：`scripts/model-preview-relay.ts` 同样
// 直接操作 `IncomingMessage` / `ServerResponse`。
//
// 本模块**不 listen**：端口选择、被占换端口、URL 打印归 S4，绑定地址（默认只绑 127.0.0.1）归 S2。
// 返回一台没在监听的 server，测试才能自由地 `listen(0)`，两张卡也各自改各自的那一层。

import { createServer as createHttpServer, type Server } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  /** 未预期异常的去处；默认写 stderr。 */
  readonly onInternalError?: (error: unknown) => void
}

export function createWebAgentServer(options: WebAgentServerOptions = {}): Server {
  const router = createRequestRouter({
    distDirectory: options.distDirectory ?? DEFAULT_DIST_DIRECTORY,
    health: { version: options.version ?? resolveServerVersion() },
    onInternalError: options.onInternalError,
  })
  // router 返回 Promise，而 `http.createServer` 的监听器是同步签名：这里显式 void 掉。
  // router 内部已经把所有异常收成 500，不会有逃逸的 rejection。
  return createHttpServer((request, response) => { void router(request, response) })
}
