// 第二道防线的材料：一次启动一枚随机 token，以及**常量时间**的比对。
//
// 这一道挡的是「本机浏览器里的另一个网站」——第一道彻底挡不住的那类。恶意页面能把请求**送到**
// 我们端口上（简单请求不触发预检、`<form>` 提交连 CORS 都不涉及），但它**不知道 token**，
// 于是请求在分派之前就被拒掉。它也是唯一一道在 DNS rebinding 下仍然成立的防线：rebinding 让
// 浏览器认为攻击者页面与我们同源，Origin 随之失去意义，但攻击者页面与**我们自己的页面**
// （`http://127.0.0.1:PORT`）依旧不同源，读不到那里的内存，也就拿不到 token。
//
// 【token 的完整链路，每一跳它在哪】
// ① 生成：server 启动时 `generateAuthToken()`，只活在进程内存里，**不落盘、不进配置、不进日志**。
// ② 打印（S4）：终端打印 `http://127.0.0.1:PORT/?token=<token>`。此处 token 在 **URL query**。
// ③ 页面加载：浏览器 GET `/?token=…` 取静态产物。静态面不校验 token（它发的是用户自己 build 的
//    公开产物），query 被静态路由忽略。
// ④ 页面接手（B2）：`location.search` 读一次 → 存进 **sessionStorage**（按 origin、按标签页，
//    F5 后还在，关标签页即失效，且与「每次启动换新 token」的生命周期对得上）→ `history.replaceState`
//    把 query 从地址栏抹掉，于是它不进浏览器历史。
// ⑤ 每条 API 请求：**`Authorization: Bearer <token>` 请求头**，不是 query。
//
// 【为什么 API 面只收请求头，不收 query】
// - query 会进服务器访问日志、进 devtools 的 URL 列、进任何一层中间设施的记录；请求头不会。
// - 更要紧的是**它顺带白送一道防线**：跨源 JS 要设自定义头就必须先过 CORS 预检，而我们对
//   `OPTIONS` 不回任何 `Access-Control-Allow-*`，浏览器于是**根本不会发出**那条真实请求。
//   `<form>` 则压根设不了请求头。所以「token 只认 header」把跨站攻击面从「送得到但没 token」
//   进一步压成「送都送不到」。反过来若也认 `?token=`，简单请求就又活了。
// - 也不用 Cookie：Cookie **不区分端口**，同一台机器上任何跑在 127.0.0.1 上的服务都能读写我们
//   这枚 Cookie；再加上它会被浏览器自动附带（CSRF 的根源），换来的只是「不用手动带头」。
//
// 【B1 拿不到 token 时会怎样】见 `authGuard.ts` 里 health 豁免那段裁决。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// 32 字节 = 256 bit 熵，远超判据要求的 128 bit。base64url 编码后 43 个字符，
// 全部落在 URL 安全字符集里（无 `+` `/` `=`），所以 S4 拼进 URL 不用转义、
// B2 用 `URLSearchParams` 读回来逐字不变。
const TOKEN_BYTES = 32

/** 每次启动调用一次。`randomBytes` 是 CSPRNG——`Math.random()` 可预测，等于没有 token。 */
export function generateAuthToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

const BEARER_SCHEME = 'bearer '

/** 从 `Authorization` 头里取出 Bearer token；形状不对一律返回 undefined（不猜、不兜底）。 */
export function readBearerToken(header: string | string[] | undefined): string | undefined {
  // Node 对重复的 `Authorization` 头只保留一个字符串，但类型上仍可能是数组；数组一律判无效，
  // 免得「取第几个」变成一次需要猜的裁决。
  if (typeof header !== 'string') return undefined
  if (!header.toLowerCase().startsWith(BEARER_SCHEME)) return undefined
  const value = header.slice(BEARER_SCHEME.length).trim()
  return value === '' ? undefined : value
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * 常量时间比对。
 *
 * 普通 `===` 对字符串是逐字符短路的：攻击者可以靠计时逐位试出前缀，把 256 bit 的暴力搜索
 * 压成 43 次线性猜测。
 *
 * 先各自 SHA-256 再比对，而不是「先比长度再 `timingSafeEqual`」：`timingSafeEqual` 在两个 Buffer
 * 长度不等时**会抛异常**，为它加的那个长度判断本身又是一条会短路的分支（且泄露 token 长度）。
 * 摘要恒为 32 字节，两个毛病一起消失。摘要在这里不是「存哈希」，只是把变长输入压成等长输入。
 */
export function tokenMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented))
}
