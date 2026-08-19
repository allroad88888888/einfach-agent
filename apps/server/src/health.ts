// `/api/health` 的载荷。
//
// 它回答的是两个问题：**这是谁**（`service` + `host`）与**跑的哪一版**（`version`）。
// 前者不是装饰：B1 的宿主探测就是「`GET /api/health` 成功 → 判定为 server 宿主」，而本机随便
// 一个开发服务器都可能在同一个端口上对 `/api/health` 回 200。没有判别字段的话，探测会把别人的
// 服务认成自己的后端，随后每一条 invoke 都莫名其妙地失败。
//
// 【S5 已把第三个问题接进来：**这台机器是什么平台**】
// core 原先在**调用方**探测 platform 再随命令传给宿主，宿主收到后拒绝与自己不符的值。Tauri 下
// 前端与原生同机，这条恒成立；浏览器（macOS）连 Node 服务端（Linux）则必然 `platform mismatch`,
// 一条 shell 命令都跑不了。所以平台改由**宿主声明**，而宿主唯一能开口的时机就是这次握手。
//
// 它接在这里而不是另加一条桥命令，是 S1 就留好的两条性质各兑现了一半：
// ① 载荷是**具名字段的 JSON 对象**，不是裸串也不是数组——加字段对老客户端向后兼容。
//    对应地，消费方（B1）必须忽略未知字段，不要写「字段集合恰好等于这几个」的断言。
// ② 载荷里的每个事实都由**调用方注入**（`HealthFacts`），本模块自己不去读 `process.platform`
//    之类的全局。平台因此从装配层传进来（`createServer.ts`），而装配层同时持有 host-node 的桥，
//    于是「握手报的平台」和「执行 shell 命令的那台机器」用的是同一个权威——那边报的正是 shell 域
//    做 `platform mismatch` 判定时调的同一个函数。反过来，如果本模块自己探测，就等于在桥之外
//    **另开一个宿主事实的来源**，正是 N1 卡面拒绝「把主目录塞进 /api/health」时点名的那种
//    「把权威劈成两处」。
//
// 除此之外本模块**不会**顺手往载荷里塞主目录、workspace 路径、能力清单这类东西：health 是身份与
// 存活应答，不是宿主事实的公告板。平台是例外，因为它必须在**桥可用之前**就被知道——B1 拿它去登记
// 命令桥（core 的 `configureHostInvoke` 要求平台与桥同一次登记），向桥要等于先有鸡还是先有蛋。
// 凡是桥已经能答、且不参与桥自身装配的，一律走桥。

export const HEALTH_PATH = '/api/health'

/** 判别用的固定标识。`einfach-agent` 的 Node HTTP 外壳，与 Tauri 原生宿主、纯静态托管三选一。 */
export const SERVICE_IDENTIFIER = 'einfach-agent'
// 刻意不叫 `server`：core 里 `runtime: 'server'` 已经表示「需要本机能力的那类工具」，
// 同一个词在同一个仓库里指两件事迟早出事。这里说的是**哪一种宿主实现**。
// B1 的三态 `'tauri' | 'server' | 'static'` 中的 `'server'`，判据就是看到这个值。
export const HOST_IDENTIFIER = 'node-server'

/**
 * 服务端 shell 认得的平台。`'unsupported'` 是真实状态而不是错误码：FreeBSD / AIX 这类机器上
 * 文件能力照常可用，只有 shell 三选一没有对应项。少了这个值，这类服务端就得在三个里谎报一个，
 * 客户端随后每条命令都以 `platform mismatch` 失败，而失败文案里没有半点「本机根本没有 shell」
 * 的信息。core 的 `HostPlatform` 是同一个四值域（`@einfach-agent/core` 导出），B1 直接照它收。
 */
export type HealthPlatform = 'macos' | 'linux' | 'windows' | 'unsupported'

export interface HealthPayload {
  readonly service: typeof SERVICE_IDENTIFIER
  readonly host: typeof HOST_IDENTIFIER
  readonly version: string
  /**
   * **执行 shell 命令的那台机器**的平台。B1 拿到后连同 HTTP invoke 一起交给 core 的
   * `configureHostInvoke({ loader, platform })`——注入给模型的「运行环境」段与 shell 桥的
   * `platform` 入参从此都读这一个值，模型据它挑 shell_macos / shell_linux / shell_powershell。
   *
   * 【B1 不要自己探测，也不要回落】浏览器上 `navigator.userAgent` 说的是**用户那台机器**，
   * 与这里说的完全是两回事，而这正是本字段存在的全部理由。握手没成功就说明还不知道自己
   * 是不是 server 宿主，那时候本来就不该登记桥。
   */
  readonly platform: HealthPlatform
}

/** 装配层注入的事实。新增字段一律走这里，不要让本模块自己去读全局。 */
export interface HealthFacts {
  readonly version: string
  readonly platform: HealthPlatform
}

export function createHealthPayload(facts: HealthFacts): HealthPayload {
  return {
    service: SERVICE_IDENTIFIER,
    host: HOST_IDENTIFIER,
    version: facts.version,
    platform: facts.platform,
  }
}
