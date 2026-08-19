// 进 `/api/*` 的唯一一道门：把三道防线按顺序串起来，判出 allow / deny。
//
// 这台 server 随后会经 `/api/invoke/:command` 暴露 `run_shell_command`、`write_workspace_file`、
// `delete_workspace_path`——**拿到 API 面 = 在用户机器上任意代码执行**。所以这道门的默认答案是拒绝，
// 每一条放行都得说得出理由。三道防线各挡各的，**没有任何一道兜得住全部**：
//
// | 防线 | 模块 | 挡住 | 挡不住 |
// | --- | --- | --- | --- |
// | 绑回环 + 对端地址 | `authLoopback.ts` | 局域网上的另一台机器 | 本机浏览器里的任何标签页 |
// | token | `authToken.ts` | 不知道 token 的一切调用方（含 rebinding 后的攻击页） | token 真的泄露之后 |
// | Origin / Host | `authOrigin.ts` | 跨站发起、DNS rebinding | 非浏览器客户端（它们本来就不受这两个头约束） |
//
// 【判定顺序及其理由】
// ① 对端地址 → ② Host → ③ Origin → ④ token。
// token 放最后是刻意的：跨站请求在拿到任何「token 对不对」的回音**之前**就被拒掉，
// 那道门后面不存在可用来试探 token 的计时或状态差异。
//
// 【缺席的 `Origin` 怎么处置：放行】
// 判据不是「缺席就可信」，而是「缺席之后还剩什么」。能合法缺席 Origin 的只有两类：
// (a) 非浏览器客户端（curl、我们自己的 CLI、测试）——它们本来就在 token 的管辖下；
// (b) 浏览器的同源 GET/HEAD，以及少数老浏览器的表单提交。
// 而 (b) 里唯一危险的形态（rebinding 下的同源 GET）**已经被 Host 挡住**：那条请求的 Host 必然是
// 攻击者的域名。于是「Origin 缺席」只是把这条请求降级成「token + Host」——与 curl 拿到的待遇
// 完全一致，没有任何一道防线因此凭空消失。
// 反过来「一律拒绝」的代价是真实的：curl 与任何脚本客户端全部不可用，而它们是 CLI 宿主与
// 排障的主要入口。**已知残余风险**：若 token 泄露给了一个能发无 Origin 请求的本机进程，
// 这一条不会再拦。但那种进程本来就能直接读我们的内存/端口，Origin 拦不住它。
//
// 【`/api/health` 豁免 token：裁决与理由】
// **裁决：health 不校验 token，但仍然校验对端地址与 Origin / Host。**
// B1 拿 `GET /api/health` 做宿主探测，而探测发生在拿到 token **之前**。两种解法的失败形态不对称：
// - 若 health 也要 token：用户从书签、第二个标签页、或 B2 抹掉 query 之后的新会话打开
//   `http://127.0.0.1:PORT/`，探测拿到 401 → B1 落到 `static` → **模型看不到任何本机能力**，
//   而界面上不会有任何一句话提到「令牌」。这正是本仓库最忌讳的静默降级。
// - 若 health 豁免：探测恒成功 → 判定为 server 宿主 → 第一条真实 invoke 拿到 401，
//   B2 可以把它渲染成一句准确的话（「缺少访问令牌，请用终端打印的完整链接打开页面」）。
//   **响亮地失败优于静默地正确。**
// 豁免泄露了什么：`{service:'einfach-agent', host:'node-server', version}`，即「这台机器上跑着
// web-agent 的哪一版」。泄露给谁：能连上回环的本机进程（它们能做的远不止读版本号），
// 以及——注意——**不包括**跨源网页：我们对任何请求都不回 `Access-Control-Allow-*`，
// 浏览器不会把响应体交给跨源脚本。而「这个端口上有东西在听」本来就靠 `no-cors` fetch 的
// 成功/失败探得到，与我们回什么无关。结论：可接受。
// **B1 照此实现：探测不带 token，且不要因为探测成功就以为后续 invoke 也会成功。**

import type { IncomingMessage } from 'node:http'
import { isLoopbackAddress } from './authLoopback'
import { isHostHeaderThisServer, judgeOriginHeader } from './authOrigin'
import { readBearerToken, tokenMatches } from './authToken'
import { HEALTH_PATH } from './health'

/** 判定所需的全部事实。收成一个平凡记录，判定逻辑因此可以脱离真实 socket 单测。 */
export interface ApiRequestFacts {
  readonly pathname: string
  readonly remoteAddress: string | undefined
  readonly localPort: number | undefined
  readonly host: string | string[] | undefined
  readonly origin: string | string[] | undefined
  readonly authorization: string | string[] | undefined
}

export interface ApiAuthConfig {
  /** 本次启动的 token。见 `authToken.ts` 的链路说明。 */
  readonly token: string
}

export type AuthDecision =
  | { readonly kind: 'allow' }
  | {
    readonly kind: 'deny'
    readonly status: number
    /** 稳定标识，给程序看；沿用 `requestRouter.ts` 的 `{ error, message }` 失败信封。 */
    readonly error: string
    readonly message: string
    readonly headers?: Readonly<Record<string, string>>
  }

const ALLOW: AuthDecision = { kind: 'allow' }

function deny(
  status: number,
  error: string,
  message: string,
  headers?: Readonly<Record<string, string>>,
): AuthDecision {
  return { kind: 'deny', status, error, message, headers }
}

export function readApiRequestFacts(request: IncomingMessage, pathname: string): ApiRequestFacts {
  return {
    pathname,
    // socket 层的事实，请求方伪造不了；下面两个头则是请求自己声称的。
    remoteAddress: request.socket.remoteAddress,
    localPort: request.socket.localPort,
    host: request.headers.host,
    origin: request.headers.origin,
    authorization: request.headers.authorization,
  }
}

export function authorizeApiRequest(facts: ApiRequestFacts, config: ApiAuthConfig): AuthDecision {
  if (!isLoopbackAddress(facts.remoteAddress)) {
    return deny(403, 'non_loopback_client', '本地服务只接受来自本机的请求。')
  }
  if (!isHostHeaderThisServer(facts.host, facts.localPort)) {
    // rebinding 的落点。文案不点破「你的 Host 是什么」——那对正常调用方没用，对攻击者是提示。
    return deny(403, 'forbidden_host', '请求的 Host 与本地服务的地址不符。')
  }
  if (judgeOriginHeader(facts.origin, facts.localPort) === 'cross-origin') {
    return deny(403, 'forbidden_origin', '本地服务不接受跨站请求。')
  }
  if (facts.pathname === HEALTH_PATH) return ALLOW
  const presented = readBearerToken(facts.authorization)
  if (presented === undefined) {
    // 401 而不是 404：未通过认证的调用方连「有哪些接口」都不该知道。
    // 标准质询头 `Bearer` 不会触发浏览器的原生登录弹窗（那是 Basic / Digest 才有的行为）。
    return deny(401, 'missing_token', '缺少访问令牌，请使用启动时打印的完整链接。', { 'www-authenticate': 'Bearer' })
  }
  if (!tokenMatches(config.token, presented)) {
    // 与 missing 分开，是为了让 B2 能说准话（「没带」和「带错了」对用户是两种处置）。
    // 这不构成预言机：调用方本来就知道自己带没带 token。
    return deny(401, 'invalid_token', '访问令牌无效，请使用启动时打印的完整链接。', { 'www-authenticate': 'Bearer' })
  }
  return ALLOW
}
