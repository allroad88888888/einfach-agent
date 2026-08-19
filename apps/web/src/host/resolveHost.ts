// 当前宿主是三态中的哪一个 —— 应用装配的第一个岔路口，`main.tsx` 之后的每个 driver 选择都从它分叉。
//
//   · `tauri`  —— 桌面端，本机能力经 Tauri 原生层的 invoke。
//   · `server` —— 浏览器 + 本机 Node 后端（`apps/server`），本机能力经 HTTP 打到 `/api/invoke/:command`。
//   · `static` —— 纯静态产物，**没有任何本机能力**：不登记桥，于是文件/shell/Git 工具整类不进模型
//     清单、执行也一律早退（`hasHostBridge()` 是那个总闸），模型请求同样被拒。
//
// ★ 判定顺序：`isTauri()` → `GET /api/health` → `static` ★
// `isTauri()` 排第一不只因为它便宜（只读 `globalThis.isTauri`，纯全局量、零副作用、不加载任何
// 模块，所以同步可答、随便早求值），更因为 Tauri 里那条 fetch 打的是 asset 协议：没有人会应答，
// 等它是纯粹的首屏延迟。桌面端因此**一次网络都不发**。
//
// ★ 探测失败一律落 `static`，而「失败」包含「永远不返回」★
// `fetch('/api/health')` 在这几种情况下会**长时间挂着而不是失败**：端口上有东西在听但从不回包、
// 网络栈被代理拦住、服务端在启动中途卡死。没有超时的话首屏就一直白着，用户完全不知道发生了
// 什么。所以下面同时上了两道：`AbortController` 真的把请求取消掉（不留在途请求），
// `Promise.race` 保证**无论 fetch 实现认不认那个 signal**，本函数都在 `timeoutMs` 内返回。
// 只上 AbortController 是不够的——「超时后一定返回」就成了对 fetch 实现的假设，而本函数的
// 全部职责恰恰是不让首屏挂在这个假设上。
//
// ★ 返回的是对象而不是裸三态字符串 ★
// 因为 `server` 这一态**必须**带出握手报的平台：S5 把 platform 做成 `configureHostInvoke` 的必填
// 字段，浏览器（macOS）连 Node 服务端（Linux）时，本地探测出来的平台是错的，一条 shell 命令都
// 跑不了。做成可辨识联合之后，「拿到 server 却没有 platform」在类型上就构不出来——B3 想漏掉它
// 得先过 `tsc -b` 那一关。`tauri` 这一态刻意**不带** platform：桌面端 webview 与原生同机，
// 权威是 core 的 `detectLocalPlatform()`，本模块没有资格也没有必要替它答。
import { isTauri } from '@tauri-apps/api/core'
import type { HostPlatform } from '@web-agent/core'
import { HEALTH_PATH, readServerPlatform } from './serverHealthContract'

export type HostKind = 'tauri' | 'server' | 'static'

/**
 * 落到 `static` 的原因。**纯诊断用**，B3 可以完全忽略它。
 *
 * 它存在是因为这条回落是本仓库最忌讳的那种静默降级：用户看到的是一个没有任何本机能力的界面，
 * 而画面上不会有一句话解释为什么。有了它，装配层至少能在控制台说准话（「本机后端没应答」跟
 * 「那个端口上是别人的服务」是两种完全不同的处置），B4 端到端验收时也不必靠猜。
 */
export type StaticHostReason =
  /** 连不上：请求直接失败（没有服务在听、`file://` 打开的产物、被代理拒绝）。 */
  | 'unreachable'
  /** 有东西在听但没在 `HEALTH_PROBE_TIMEOUT_MS` 内答完。 */
  | 'timeout'
  /** 答了，但不是 2xx（真·静态部署下 `/api/health` 通常就是 404）。 */
  | 'unhealthy'
  /** 答了 2xx，但不是我们的握手：别人的开发服务器、或 SPA 回落回来的一整页 HTML。 */
  | 'unrecognized'

export type ResolvedHost =
  | { readonly kind: 'tauri' }
  | { readonly kind: 'server'; readonly platform: HostPlatform }
  | { readonly kind: 'static'; readonly reason: StaticHostReason }

/**
 * 握手超时。**2 秒。**
 *
 * 取值是「慢的本地服务」与「用户盯着白屏」之间的取舍，而两边的代价不对称：
 * · 定短了 → 一台真的 server 宿主被判成 static → 模型看不到任何本机能力，**且不报错**。
 * · 定长了 → 多等最多 2 秒才落到 static，而 static 本来就是能力最少的那一态，晚一点到达没有
 *   任何东西被破坏。
 * 静默降级比可见的等待贵得多，所以往宽了取。
 *
 * 上界为什么仍然是「秒」这个量级：server 宿主下这条请求是**同源回环**的——静态产物本身就是那台
 * server 发出来的，正常情况毫秒级。留 2 秒是给冷启动的 Node 进程在服务完 JS 产物之后第一次处理
 * 请求的那点抖动，不是给跨网络的往返。再长就纯粹是在浪费用户的时间了。
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2000

/** 探测只用得到 `Response` 的这三样。写窄是为了让测试用一个平凡对象就能满足它。 */
interface HealthProbeResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

type HealthProbeFetch = (
  input: string,
  init: { readonly signal: AbortSignal },
) => Promise<HealthProbeResponse>

/**
 * 全部可替换的依赖，**都有生产默认值**：`resolveHost()` 不带参就是生产行为。
 *
 * 【为什么是依赖注入而不是 `vi.stubGlobal('fetch', …)`】jsdom 下 `globalThis.fetch` 是**真会发
 * 请求**的。靠 stub 的话，「测试绝不能真的发网络请求」这条就退化成「每个用例都记得 stub」，
 * 漏一个不会红灯，只会让那个用例去连一台不存在的 `localhost`（本机恰好有东西在听时甚至能过）。
 * 注入之后这件事是结构性的：本模块自己从不去碰全局 fetch 以外的东西，而测试给的永远是假的。
 * `timeoutMs` 同样注入，否则一条超时用例要真等 2 秒。
 *
 * `AbortController` 刻意**没有**做成可注入：它是纯内存对象、不碰网络，测试用真的那个反而更有
 * 说服力——下面那条「超时后 signal 真的 aborted」的断言，注入个假的就断言不出什么了。
 */
export interface ResolveHostOptions {
  readonly isTauriHost?: () => boolean
  readonly fetch?: HealthProbeFetch
  readonly timeoutMs?: number
}

const defaultProbeFetch: HealthProbeFetch = (input, init) => globalThis.fetch(input, init)

function staticHost(reason: StaticHostReason): ResolvedHost {
  return { kind: 'static', reason }
}

/**
 * 读一次握手。**永不 reject** —— 它是 `Promise.race` 的一边，reject 会变成没人接的拒绝。
 * 每一种失败都被分类成一个 `static`。
 */
async function readHealth(
  probeFetch: HealthProbeFetch,
  signal: AbortSignal,
): Promise<ResolvedHost> {
  let response: HealthProbeResponse
  try {
    response = await probeFetch(HEALTH_PATH, { signal })
  } catch {
    return staticHost(signal.aborted ? 'timeout' : 'unreachable')
  }
  if (!response.ok) return staticHost('unhealthy')

  // 真·静态部署把未知路径 SPA 回落成一整页 `index.html` 时，这里拿到的是 `text/html`，
  // `json()` **会抛**。那不是异常状况而是这条链路上最常见的一种应答，必须就地吃掉分类成
  // `unrecognized`，绝不能变成未捕获错误把首屏一起带走。
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    if (signal.aborted) throw error
    return staticHost('unrecognized')
  }

  const platform = readServerPlatform(payload)
  return platform === undefined ? staticHost('unrecognized') : { kind: 'server', platform }
}

async function probeServerHost(
  probeFetch: HealthProbeFetch,
  timeoutMs: number,
): Promise<ResolvedHost> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ResolvedHost>((resolve) => {
    timer = setTimeout(() => {
      // 先取消真实请求再兑现答案：只 resolve 不 abort 的话，首屏是不挂了，但那条请求还挂在
      // 连接池里，而它此刻已经没有任何消费方。
      controller.abort()
      resolve(staticHost('timeout'))
    }, timeoutMs)
  })

  // readHealth 自己在 signal 上挂了 abort 的处置；race 只保证「本函数一定返回」这一半。
  const probe = readHealth(probeFetch, controller.signal).catch(() => staticHost('timeout'))
  try {
    return await Promise.race([probe, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析当前宿主。**装配层应当在 `bootstrapApplication()` 之前把它 await 掉**，而不是并行发起：
 * 恢复出来的会话可能带着未完成的 run，那是工具真正可能执行的第一个时点，桥必须先于它到位。
 */
export async function resolveHost(options: ResolveHostOptions = {}): Promise<ResolvedHost> {
  const isTauriHost = options.isTauriHost ?? isTauri
  if (isTauriHost()) return { kind: 'tauri' }

  return probeServerHost(
    options.fetch ?? defaultProbeFetch,
    options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS,
  )
}
