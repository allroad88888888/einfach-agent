// openai-compat 的登记接入点判据：一条 base URL 凭什么能被当成上行目标
// ---------------------------------------------------------------------------
// ═══ 为什么单独有这个文件 ═══
// providerRoute.ts 那张端点白名单的**全部价值**是「origin 不来自调用方」：前三家的 origin 是
// 写死在表里的常量，调用方只能给 (provider, scope, method, path)。openai-compat 打破的正是这个
// 前提——它没有厂商官方接入点，baseUrl **由用户填**，于是「精确匹配一个已知 origin」在它身上
// 无从谈起。放开成「调用方给什么就打什么」等于把这一层变回开放代理，而 Key 是宿主自己从配置
// 里取的、调用方看不见也拦不住。
//
// 本仓库的替代约束是**显式许可清单**，一共两条，缺一不可：
//
//   ① **只有一条，且是用户显式登记的那条**。origin 仍然不来自调用方：它从
//      `~/.webAgent/config.json` 的 `openai-compat:default:baseUrl` 读出来（openAiCompatEndpoint.ts），
//      调用方连表达 origin 的字段都没有。没登记过 = 目标未获允许，openai-compat 在登记之前
//      完全不可用（fail closed）。「许可清单」的长度是 1 不是 0 也不是 ∞。
//
//   ② **那条 URL 本身要过下面这张结构判据**，写入时判一次、每次上行前再判一次。两次都判不是
//      冗余：写入那次给用户一条能看懂的拒绝，读取那次挡的是**绕过面板直接手改配置文件**
//      （config.json 是用户自己的文件，谁都能编辑，它不是可信输入）。
//
// ═══ 结构判据逐条的理由 ═══
//   · **https，或指向回环地址的 http**。API Key 走 Authorization 头明文上行，明文 http 打到
//     远端主机等于把 Key 交给链路上的任何人。自建网关跑在 `http://127.0.0.1:8080` 是这一家最
//     典型的形态，所以回环例外必须留——但只留给回环，不留给「内网地址」（判不准，且 DNS 能
//     把任意名字解析到内网）。
//   · **不许内嵌用户名密码**。`https://user:pass@host` 里的凭据会被 fetch 变成一个额外的
//     Authorization 头，与本域「Key 只从配置读、只出现在一个头里」的红线直接冲突；而且它会
//     原样躺在配置文件里，与 Key 混在同一段却不受 Key 的任何约束。
//   · **不许带 query 与 fragment**。上行 URL 是 `origin + path` 拼出来的，base 里带 `?a=b` 会让
//     拼接结果变成 `...?a=b/chat/completions`——一个既不是 chat 端点、也不再受路径白名单管的
//     地址。这与前三家「路径必须字面全等」是同一条规则的延伸。
//   · **长度有上限**。配置里的值最终要进 URL，留个硬顶免得一条畸形长值一路带到 fetch。
//
// ═══ 它挡不住什么（写在这里，不要指望它） ═══
// 用户**故意**登记一个恶意 https 端点，它挡不住，也不该挡：那是用户对自己那把 openai-compat
// Key 的处置权。但代价被限制在那一把 Key 上——`forwardRequest.ts` 用的是**解析出的**
// `target.provider` 去读凭证，所以 openai-compat 的 origin 永远拿不到 DeepSeek/GLM/Kimi 的 Key。
// 它同样不做 TLS 证书固定，也不阻止用户把回环例外指向本机某个非模型服务（同属显式登记）。

import { modelRequestError } from './errors'

/** 配置值的硬顶。URL 再长也不该接近这个数，纯粹是防畸形值一路带下去。 */
const MAX_BASE_URL_LENGTH = 512

/** 用户可见的规则说明。设置面板与错误提示都引它，避免第二处各写一句措辞不同的解释。 */
export const OPENAI_COMPAT_BASE_URL_RULE
  = '接入点必须是 https:// 地址，或指向本机回环地址（localhost / 127.x.x.x / [::1]）的 http://；'
  + '不接受 query、fragment 与内嵌的用户名密码。'

/** 127.0.0.0/8 的点分形态。WHATWG URL 已经把 `127.1` 之类归一成四段，这里只认归一后的形态。 */
const IPV4_LOOPBACK_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * 这个主机名是不是本机回环。
 *
 * `url.hostname` 对 IPv6 会带方括号（`[::1]`），对 IPv4 已经过归一化（`127.1` → `127.0.0.1`），
 * 所以这里比对的是归一后的形态而不是用户敲进来的原文。
 * `localhost` 之外不认任何别名（`localhost.localdomain`、尾点形态一律不认）：认得越多，
 * 「这个名字到底解析到哪」就越不是本文件能回答的问题。
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (hostname === '[::1]') return true
  return IPV4_LOOPBACK_PATTERN.test(hostname)
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * 判据本体。通过则返回**归一化**后的 origin（`origin + pathname`，去掉末尾斜杠），不通过返回
 * `undefined`。
 *
 * 归一化不是顺手做的：上行 URL 是 `origin + path` 直接拼接，base 末尾留一个 `/` 会拼出
 * `https://h/v1//chat/completions`。同一个端点在两种写法下变成两个 URL，缓存、日志、以及
 * 「登记的是不是同一个地址」的比对全都跟着分叉。
 */
export function normalizeOpenAiCompatBaseUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_BASE_URL_LENGTH) return undefined
  const url = parseUrl(trimmed)
  if (!url) return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.search !== '' || url.hash !== '') return undefined
  if (url.protocol === 'http:') {
    if (!isLoopbackHostname(url.hostname)) return undefined
  } else if (url.protocol !== 'https:') {
    return undefined
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** `normalizeOpenAiCompatBaseUrl` 的受控失败形态：不通过时抛本域的 `invalidBaseUrl`。 */
export function requireOpenAiCompatBaseUrl(value: string): string {
  const normalized = normalizeOpenAiCompatBaseUrl(value)
  if (normalized === undefined) throw modelRequestError('invalidBaseUrl')
  return normalized
}
