// 两个事件的载荷形状 —— 类型面与运行期键表
// ---------------------------------------------------------------------------
// 上游权威是桌面宿主 `apps/desktop/src/mcp_lifecycle.rs`：
//
//   #[derive(Serialize)] #[serde(rename_all = "camelCase")]
//   struct McpLifecycleEventPayload { server_id: String, session_token: String }        // tools-changed
//   struct McpCloseEventPayload     { server_id: String, session_token: String, message: String }
//
// 所以线上的键是 **camelCase**（`serverId` / `sessionToken` / `message`），三个字段都是**必填**
// 字符串。这一点值得点名，因为消费侧的 `apps/web/src/mcp/tauriStdioConnector.ts` 把 close 的
// `message` 声明成了 `message?: string` 并备了一句兜底文案——那是**消费方的防御**，不是契约。
// 契约以发射方为准：Node 侧发 close 必须带 message。C4 抄那个 connector 时可以保留它的兜底
// （多一层防御不亏），但别据此把这里改成可选：可选字段值为 `undefined` 时，进程内那条路上
// 键存在而过了 JSON 键消失，正是 `jsonPayload.ts` 开头那张表里的第一行。
//
// 【为什么载荷里带 sessionToken，以及为什么本域不做按 server 的路由】
// Rust 侧是 `app.emit(...)`——**全局广播**，每个连接的 listener 都会收到所有 server 的事件，
// 由 `tauriStdioConnector.ts` 的 `isLifecycleEventForSession` 按 `(serverId, sessionToken)` 自己过滤。
// 本域刻意保持同一形状：不提供「只订阅某个 serverId」的入口。理由是 C4 要写的是
// `tauriStdioConnector.ts` 的同接口替身，两侧过滤逻辑必须能逐字照搬；这里多一层路由，
// C4 就得为两种宿主写两套过滤，而那正是会漂移的地方。sessionToken 的作用也在这里：
// 同一个 serverId 重连后是新会话，旧连接的 listener 必须能认出「这条事件不是我的」。

import type { JsonRecord } from './jsonPayload'
import type { HostEventName } from './hostEventNames'

/** `mcp-stdio-tools-changed`：子进程报告它的工具清单变了，消费方应重新 `tools/list`。 */
export type McpStdioToolsChangedPayload = {
  readonly serverId: string
  readonly sessionToken: string
}

/** `mcp-stdio-close`：子进程/传输意外结束。`message` 是给人看的原因，恒有值。 */
export type McpStdioClosePayload = {
  readonly serverId: string
  readonly sessionToken: string
  readonly message: string
}

/**
 * 事件名 → 载荷形状。
 *
 * `extends Record<HostEventName, JsonRecord>` 是**编译期的载荷约束落点**：往任何一个载荷里加
 * 一个 `Date` / 函数 / `Map` 字段，这个 interface 当场报 "incorrectly extends"，指着那一行。
 * 理由见 `jsonPayload.ts` 的文件头（三种传输必须看到同一个值）。
 *
 * 载荷本身写成 `type` 而不是 `interface`：TS 只给「对象字面量的类型别名」隐式索引签名，
 * interface 声明拿不到，于是 `interface` 形态的载荷即使字段全是 string 也过不了上面那条
 * `extends JsonRecord`（报 "Index signature is missing"）。这不是风格偏好，是硬约束。
 */
export interface HostEventPayloadMap extends Record<HostEventName, JsonRecord> {
  'mcp-stdio-tools-changed': McpStdioToolsChangedPayload
  'mcp-stdio-close': McpStdioClosePayload
}

/** 某个事件的载荷类型。 */
export type HostEventPayload<Name extends HostEventName = HostEventName> = HostEventPayloadMap[Name]

/**
 * 载荷字段的**运行期**形态。存在的唯一理由是让 `hostEventNames.test.ts` 能拿它去和
 * `mcp_lifecycle.rs` 的 struct 字段逐字对拍——类型在运行期没有影子，对拍需要一份可读的值。
 * 口径同 `commandNames.ts` 的 `NODE_HOST_COMMAND_NAMES`。
 *
 * 两道约束一起把「表与类型漂移」堵死，缺一不可：
 *   · 下面的 `satisfies`：表里写了类型上不存在的键 → 在字面量那一行报错（子集方向）。
 *   · 再下面的 `_payloadKeysAreExhaustive`：类型里加了字段而表没跟上 → 报错（超集方向）。
 * 只有 `satisfies` 时，新加的字段会静默不进对拍——那字段就永远不会被和 Rust 比对。
 */
export const HOST_EVENT_PAYLOAD_KEYS = {
  'mcp-stdio-tools-changed': ['serverId', 'sessionToken'],
  'mcp-stdio-close': ['serverId', 'sessionToken', 'message'],
} as const satisfies { [Name in HostEventName]: readonly (keyof HostEventPayloadMap[Name])[] }

type SameKeys<Listed, Declared> = [Listed] extends [Declared]
  ? ([Declared] extends [Listed] ? true : never)
  : never

const _payloadKeysAreExhaustive: {
  [Name in HostEventName]: SameKeys<
    (typeof HOST_EVENT_PAYLOAD_KEYS)[Name][number],
    keyof HostEventPayloadMap[Name]
  >
} = {
  'mcp-stdio-tools-changed': true,
  'mcp-stdio-close': true,
}
void _payloadKeysAreExhaustive
