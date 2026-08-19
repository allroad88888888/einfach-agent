// token 的获取、持久化与地址栏清理 —— S2 设计链路的第④跳。
// ---------------------------------------------------------------------------
// 完整链路（S2 `authToken.ts` 文件头）：
//   ① server 启动生成 → ② 打印在 URL 的 query 里（`http://127.0.0.1:PORT/?token=…`）→
//   ③ 页面加载，静态面不校验、query 被忽略 → **④ 本文件**：`location.search` 读一次 →
//   存 sessionStorage → `history.replaceState` 抹掉 query（保留其余部分）→
//   ⑤ 之后每条 API 请求带 `Authorization: Bearer`（serverInvoke.ts 落地）。
//
// 【为什么是 sessionStorage 不是 localStorage】token 每次启动 server 都换新；localStorage
// 跨浏览器重启存活，会让陈旧 token 在下次启动后继续被使用并稳定拿到 401，而症状（"突然什么都
// 点不动"）离病因（"上周的 token 还留着"）很远。sessionStorage 按 origin 按标签页：F5 还在，
// 关标签页失效，与 token 的生命周期对得上。
//
// 【query 与 sessionStorage 都有且不同：query 赢】
// 判定在 `getServerInvokeToken()` 里体现为——只要这一次 `location.search` 里有 token，就无条件
// 覆盖 sessionStorage 里已经有的值。理由是新鲜度：query 里的 token 由用户**当下**的动作带进来
// （点开或粘贴了终端刚打印的新链接），而 sessionStorage 是这个标签页更早某次访问留下的历史状态。
// token 每次启动都换新，于是"同一个标签页里，地址栏换成了新链接，但 sessionStorage 还留着上次
// 启动时存的旧 token"是一个会真实发生的场景（重启 server 后用户在同一个标签页粘贴新链接）——
// 此时如果 sessionStorage 赢，用户会拿着一个看起来"应该有效"的新链接却仍然收到 401，且没有任何
// 提示告诉他问题出在旧缓存上。query 赢，用户体感上"打开新链接就能用"，符合直觉。
//
// 【新开标签页：地址栏没有 token，sessionStorage 也没有】
// `getServerInvokeToken()` 返回 `undefined`。本文件不为此另编一句错误文案——serverInvoke.ts
// 仍会把请求发出去（只是不带 `Authorization` 头），server 侧 `authGuard.ts` 会给出 401
// `missing_token`，那句"缺少访问令牌，请使用启动时打印的完整链接。"已经是最准确的措辞。
// 客户端另起一份文案只会制造第二个可能与服务端脱节的权威——与 S3 交回时"命令名合法性只有
// host-node 一处权威"是同一个理由。
//
// 【"读一次"是结构性的，不是靠一个 "是否已读过" 的标志位】
// `getServerInvokeToken()` 每次调用都会重新检查 `location.search`，但 URL 里的 token 只可能被
// 消费一次：一读到就立刻从地址栏抹掉（保留 path/其余 query/hash），下一次调用时 query 里已经
// 没有它了，自然读不到第二次。好处是不需要模块级"initialized"状态，测试之间也不用记得复位。

/** 本模块只用得到这三样的这几个成员，写窄便于测试用平凡对象满足（同 resolveHost.ts 的写法）。 */
export interface ServerInvokeTokenLocation {
  readonly href: string
}

export interface ServerInvokeTokenHistory {
  readonly state: unknown
  replaceState(state: unknown, unused: string, url?: string | URL | null): void
}

export interface ServerInvokeTokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ServerInvokeTokenEnvironment {
  readonly location: ServerInvokeTokenLocation
  readonly history: ServerInvokeTokenHistory
  readonly sessionStorage: ServerInvokeTokenStorage
}

/** 生产默认值：真实 `window`。惰性求值（不是模块级常量）——避免 import 这个文件本身就去碰
 * `window.sessionStorage`（沙箱/受限环境下这个属性访问本身可能抛）。 */
function defaultEnvironment(): ServerInvokeTokenEnvironment {
  return {
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
  }
}

/** 与 S4 打印的 URL 形态对应：`http://127.0.0.1:PORT/?token=<token>`。 */
const TOKEN_QUERY_PARAM = 'token'

/** sessionStorage 的 key，加前缀避免与页面其它用途的 key 撞名。 */
const TOKEN_STORAGE_KEY = 'web-agent:server-invoke-token'

function safeParseUrl(href: string): URL | undefined {
  try {
    return new URL(href)
  } catch {
    // 理论上不可达（`location.href` 恒是合法绝对 URL），防御性地不让一次解析失败连累整条链路。
    return undefined
  }
}

function readStoredToken(env: ServerInvokeTokenEnvironment): string | undefined {
  try {
    return env.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** 返回是否写入成功——写入失败时调用方不应该去清地址栏（见下）。 */
function trySetStoredToken(env: ServerInvokeTokenEnvironment, value: string): boolean {
  try {
    env.sessionStorage.setItem(TOKEN_STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}

/** 抹掉 query 里的 `token`，保留 path、其余 query 参数与 hash。 */
function stripTokenFromUrl(env: ServerInvokeTokenEnvironment, url: URL): void {
  url.searchParams.delete(TOKEN_QUERY_PARAM)
  const cleaned = `${url.pathname}${url.search}${url.hash}`
  try {
    env.history.replaceState(env.history.state, '', cleaned)
  } catch {
    // 清不掉地址栏不影响功能——token 已经进了 sessionStorage（走到这里前提是写入成功）。
    // 代价只是地址栏会继续挂着 token；下次调用会重新触发一次同样的 setItem，是幂等的，无害。
  }
}

/**
 * 若 `location.search` 里有 `token`，消费它：写进 sessionStorage、清地址栏，并把这次读到的值
 * 直接返回（不必等下一次调用去读 sessionStorage）。sessionStorage 写入失败时**不清地址栏**——
 * 否则 token 会哪儿都不在：不在 storage 里，也从 URL 上消失了。
 */
function consumeTokenFromLocation(env: ServerInvokeTokenEnvironment): string | undefined {
  const url = safeParseUrl(env.location.href)
  if (!url) return undefined
  const queryToken = url.searchParams.get(TOKEN_QUERY_PARAM)
  if (!queryToken) return undefined

  const persisted = trySetStoredToken(env, queryToken)
  if (persisted) stripTokenFromUrl(env, url)
  return queryToken
}

/**
 * 取当前可用的 token。query 存在则赢（见文件头「谁赢」），否则退到 sessionStorage 里已经存的值；
 * 两者都没有时返回 `undefined`——调用方（serverInvoke.ts）据此发一条不带 `Authorization` 头的
 * 请求，让 server 给出准确的 401。
 */
export function getServerInvokeToken(
  env: ServerInvokeTokenEnvironment = defaultEnvironment(),
): string | undefined {
  const fromQuery = consumeTokenFromLocation(env)
  if (fromQuery !== undefined) return fromQuery
  return readStoredToken(env)
}
