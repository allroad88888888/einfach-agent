// 第三道防线：两个头部说的「我从哪来」与「我发往哪」是不是本机上的这台 server。
//
// 这一道挡的是浏览器语境下的两类攻击，**两个头各挡一类，缺一不可**：
//
// ① `Origin` —— 挡跨站发起。用户在开着本 server 的同时访问 evil.com，那页面里的 JS 可以
//    `fetch('http://127.0.0.1:PORT/api/…', {method:'POST'})`：简单请求不触发预检，请求照样送达并
//    执行，攻击者读不到响应不代表命令没跑。`<form method=post>` 更是连 CORS 都不涉及。这两种
//    形态浏览器都会带上 `Origin: http://evil.com`，与我们的 authority 对不上，当场拒。
//
// ② `Host` —— 挡 DNS rebinding。攻击者把自己的域名解析到 127.0.0.1，于是浏览器认为
//    `http://evil.com:PORT` 与 `http://evil.com:PORT/api/…` **同源**，Origin 检查随之失效：
//    同源 GET 压根不发 Origin，同源 POST 发的是 `http://evil.com:PORT`（它自己的域名）。
//    但 `Host` 一定是 URL 里的 authority，也就是 `evil.com:PORT`——浏览器不会替它改写成
//    我们的地址，页面 JS 也设不了这个头（forbidden header name）。所以 rebinding 下
//    **Host 是唯一还在说真话的那个头**。答案：Host 必须校验。
//
// 【端口从哪来】不从配置来，从 `socket.localPort` 来——请求实际落在哪个端口，内核最清楚。
// 这样 S2 不必知道 S4 会选哪个端口（`createWebAgentServer` 刻意不 listen），也不存在
// 「换了端口忘了同步配置」这一类漂移。
//
// 【只认 http:】本 server 只讲明文 HTTP，同一个端口上不可能同时存在一个 TLS 来源；
// 放行 `https:` 只会凭空多一种可接受的 Origin 写法。反代/TLS 终结不在本树范围内。
//
// 【考虑过但没加 `Sec-Fetch-Site`】它同样是页面伪造不了的头，但 rebinding 下它会如实报
// `same-origin`（浏览器真这么认为），补不上 Origin 的缺口——那个缺口是 Host 补的；
// 而非浏览器客户端根本不发它，于是又多一个「缺席怎么办」的裁决。收益为零，不加。

/** 允许出现在 `Host` / `Origin` 里的主机名。与 `authLoopback.ts` 的**对端地址**集合是两回事。 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  // `localhost` 由浏览器与操作系统硬映射到回环，攻击者无法把它解析到别处（rebinding 的落点
  // 只能是自己控制的域名）。用户手敲地址栏时打的多半是它，不收会把正常用法拒掉。
  'localhost',
])

const DEFAULT_PORT_BY_SCHEME: Readonly<Record<string, number>> = { 'http:': 80 }

interface Authority {
  readonly hostname: string
  /** 缺省表示「用协议默认端口」。 */
  readonly port: number | undefined
}

/**
 * 按 RFC 3986 的 authority 形态拆 `host[:port]`，**不借 `new URL`**：
 * URL 解析会顺手做归一（大小写、默认端口消除、IDNA），而我们要判的恰恰是原始字符串本身。
 */
function splitAuthority(authority: string): Authority | undefined {
  const trimmed = authority.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('[')) {
    // IPv6 字面量：`[::1]` 或 `[::1]:3000`。
    const close = trimmed.indexOf(']')
    if (close === -1) return undefined
    const hostname = trimmed.slice(0, close + 1)
    const rest = trimmed.slice(close + 1)
    if (rest === '') return { hostname, port: undefined }
    if (!rest.startsWith(':')) return undefined
    return withPort(hostname, rest.slice(1))
  }
  const colon = trimmed.indexOf(':')
  if (colon === -1) return { hostname: trimmed, port: undefined }
  // 未加方括号的裸 IPv6（含第二个冒号）是非法 authority，判无效而不是硬拆。
  if (trimmed.indexOf(':', colon + 1) !== -1) return undefined
  return withPort(trimmed.slice(0, colon), trimmed.slice(colon + 1))
}

function withPort(hostname: string, rawPort: string): Authority | undefined {
  if (!/^\d{1,5}$/.test(rawPort)) return undefined
  const port = Number(rawPort)
  return port >= 1 && port <= 65535 ? { hostname, port } : undefined
}

function isThisServer(authority: Authority, scheme: string, localPort: number | undefined): boolean {
  if (localPort === undefined) return false
  if (!LOOPBACK_HOSTNAMES.has(authority.hostname.toLowerCase())) return false
  return (authority.port ?? DEFAULT_PORT_BY_SCHEME[scheme]) === localPort
}

/**
 * `Host` 是否指向本机上的这台 server。
 *
 * 缺席一律判否：HTTP/1.1 要求必须带 `Host`，所有浏览器与 curl 都带。缺席只可能是手工构造的
 * 请求，而「手工构造」正是我们要求它证明自己的场景——放行等于给 rebinding 留一条没有 Host 的旁路。
 */
export function isHostHeaderThisServer(header: string | string[] | undefined, localPort: number | undefined): boolean {
  if (typeof header !== 'string') return false
  const authority = splitAuthority(header)
  return authority !== undefined && isThisServer(authority, 'http:', localPort)
}

export type OriginVerdict = 'absent' | 'same-origin' | 'cross-origin'

/**
 * `Origin` 的三态判定。**缺席与跨源是两件事**，怎么处置由 `authGuard.ts` 裁决并写明理由——
 * 本模块只负责把事实说准。
 *
 * 字面量 `null` 判**跨源**而不是缺席：沙箱 iframe、`file://` 页面、跨源重定向都会发出
 * `Origin: null`，那恰恰是攻击者能构造的一种来源，绝不能因为「不是我们的 authority 但也不是
 * 别人的域名」而蒙混成 absent。
 */
export function judgeOriginHeader(header: string | string[] | undefined, localPort: number | undefined): OriginVerdict {
  if (header === undefined) return 'absent'
  if (typeof header !== 'string') return 'cross-origin'
  const trimmed = header.trim()
  if (trimmed === '') return 'absent'
  const separator = trimmed.indexOf('://')
  if (separator === -1) return 'cross-origin'
  const scheme = `${trimmed.slice(0, separator).toLowerCase()}:`
  if (scheme !== 'http:') return 'cross-origin'
  const authority = splitAuthority(trimmed.slice(separator + 3))
  if (authority === undefined) return 'cross-origin'
  return isThisServer(authority, scheme, localPort) ? 'same-origin' : 'cross-origin'
}
