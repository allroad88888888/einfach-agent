// `/api/health` 的载荷。
//
// 它回答的是两个问题：**这是谁**（`service` + `host`）与**跑的哪一版**（`version`）。
// 前者不是装饰：B1 的宿主探测就是「`GET /api/health` 成功 → 判定为 server 宿主」，而本机随便
// 一个开发服务器都可能在同一个端口上对 `/api/health` 回 200。没有判别字段的话，探测会把别人的
// 服务认成自己的后端，随后每一条 invoke 都莫名其妙地失败。
//
// 【留给 S5 的接缝，以及它为什么长这样】
// S5 要解决的是「shell 的 platform 该由宿主说了算」：core 今天在**调用方**探测 platform 再随命令
// 传下去，浏览器（macOS）连 Node 服务端（Linux）时必然 mismatch。它的正解可能是握手带回平台，
// 也可能是加一条桥命令。**本卡不替它选**，只保证两条路都不被这里的形状堵死：
//
// ① 载荷是**具名字段的 JSON 对象**，不是裸串也不是数组——加字段对老客户端向后兼容。
//    对应地，消费方（B1）必须忽略未知字段，不要写「字段集合恰好等于这三个」的断言。
// ② 载荷里的每个事实都由**调用方注入**（`HealthFacts`），本模块自己不去读 `process.platform`
//    之类的全局。真要把平台放进握手，它会从装配层传进来——而装配层同时持有 host-node 的桥，
//    于是「握手报的平台」和「执行 shell 命令的那台机器」用的是同一个权威。反过来，如果本模块
//    自己探测，就等于在桥之外**另开一个宿主事实的来源**，正是 N1 卡面拒绝「把主目录塞进
//    /api/health」时点名的那种「把权威劈成两处」。
//
// 同理，本模块**不会**顺手往载荷里塞主目录、workspace 路径、能力清单这类东西：health 是身份与
// 存活应答，不是宿主事实的公告板。凡是桥已经能答的，走桥。

export const HEALTH_PATH = '/api/health'

/** 判别用的固定标识。`web-agent` 的 Node HTTP 外壳，与 Tauri 原生宿主、纯静态托管三选一。 */
export const SERVICE_IDENTIFIER = 'web-agent'
// 刻意不叫 `server`：core 里 `runtime: 'server'` 已经表示「需要本机能力的那类工具」，
// 同一个词在同一个仓库里指两件事迟早出事。这里说的是**哪一种宿主实现**。
// B1 的三态 `'tauri' | 'server' | 'static'` 中的 `'server'`，判据就是看到这个值。
export const HOST_IDENTIFIER = 'node-server'

export interface HealthPayload {
  readonly service: typeof SERVICE_IDENTIFIER
  readonly host: typeof HOST_IDENTIFIER
  readonly version: string
}

/** 装配层注入的事实。新增字段一律走这里，不要让本模块自己去读全局。 */
export interface HealthFacts {
  readonly version: string
}

export function createHealthPayload(facts: HealthFacts): HealthPayload {
  return {
    service: SERVICE_IDENTIFIER,
    host: HOST_IDENTIFIER,
    version: facts.version,
  }
}
