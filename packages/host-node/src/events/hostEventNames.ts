// 宿主事件名的全集 —— 收敛的联合类型，不是开放字符串
// ---------------------------------------------------------------------------
// 【为什么不是开放字符串】这是本域最先要裁决的一件事，因为它决定了「写错」的表现形式。
//
//   · 开放字符串：`onHostEvent('mcp-stdio-clos', h)` 编译通过、运行不报错，只是那个 handler
//     永远不会被调用。症状是「MCP 服务退出了但前端没反应」——既不抛异常、也不指向病因，
//     排查要从「事件发出来了吗」一路怀疑到「订阅上了吗」。这正是本仓库反复吃过的那种亏。
//   · 收敛联合：同一行代码当场编译失败，指着那个字面量说它不在全集里。
//
// 代价是「C1/C3 加新事件要回来改这个文件」。这个代价是**想要的**：事件面是三种传输
// （CLI 进程内 / HTTP SSE / Tauri sidecar）共用的契约，加一个事件意味着 C3 的 SSE 编解码、
// C4 的前端订阅都得跟上。让它必须经过一处集中登记，等于强制那次改动被看见；藏在字符串里
// 的新事件只会在某一条传输上悄悄不通。口径与 `commandNames.ts` 的 28 条命令全集完全一致。
//
// 【为什么还要一个运行期判据】联合类型只在编译期成立。C3 从 SSE 帧里读回来的 `event:` 字段
// 是 `string`，C4 收到的同样是外部输入——那一头必须有东西能问「这是不是一个真事件名」，
// 否则要么写 `as HostEventName` 把外部输入伪装成已校验，要么把未知事件名静默丢掉。
// 判据用 Set 而不是对象查表：对象查表会被 `'toString'` / `'constructor'` 这类
// `Object.prototype` 上的键蒙混过去（同 `isNodeHostCommandName` 的记档）。

/**
 * 宿主可以主动发出的全部事件。**唯一权威**，上游是桌面宿主
 * `apps/desktop/src/mcp_lifecycle.rs` 里的两个 `const … : &str`；
 * `hostEventNames.test.ts` 逐字对拍，Rust 侧改名而这里没跟上会当场红。
 *
 * 两条都是 MCP stdio 子进程的生命周期通知。它们**不是**某条命令的返回值：
 * 命令桥 `HostInvoke` 的签名是 `(cmd, args) => Promise<T>`，只能表达「我问、宿主答」，
 * 而这两件事是宿主主动发生的（子进程自己退出了、它的工具清单变了）。反向通道装不进那个
 * 形状，所以事件面是独立契约，不是命令域的实现细节。
 */
export const HOST_EVENT_NAMES = [
  'mcp-stdio-tools-changed',
  'mcp-stdio-close',
] as const

export type HostEventName = (typeof HOST_EVENT_NAMES)[number]

const HOST_EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(HOST_EVENT_NAMES)

/**
 * 运行期判据：给「事件名来自外部输入」的那一头用（C3 解 SSE 帧、C4 收订阅）。
 *
 * 收 `unknown` 而不是 `string`：JSON 解出来的字段可能根本不是字符串，让调用方先自己判一次
 * `typeof` 等于把同一件事写两遍，而漏写的那一次就是 `undefined.startsWith` 那类崩溃。
 */
export function isHostEventName(value: unknown): value is HostEventName {
  return typeof value === 'string' && HOST_EVENT_NAME_SET.has(value)
}
