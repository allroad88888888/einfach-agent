// MCP stdio 传输的协议版本、默认值与安全上限
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_limits.rs（已随 T1 删除），逐值相同。**不要在这里「顺手调优」**：
// 这些数字是两个宿主的共同对外契约，桌面端与 Node 端对同一台 MCP server 必须给出同一个
// 判决（同一份配置在浏览器版里能连、在桌面版里超限，是最难查的那类分叉）。
//
// 一处 Rust 没有的常量在文件末尾：`CHILD_WAIT_POLL_MS` 在 Node 侧无处可用，理由写在那里。

/** 本客户端唯一实现的 MCP 协议版本。不降级协商——见 docs/mcp-integration.md「支持范围」。 */
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25'

/** 单次 JSON-RPC 请求的默认超时。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** 调用方能要到的最长超时；超过一律钳到这里，不报错。 */
export const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000

/** disconnect 时等子进程自己退出的默认宽限期，之后强杀。 */
export const DEFAULT_DISCONNECT_GRACE_MS = 500

/** 调用方能要到的最长宽限期。 */
export const MAX_DISCONNECT_GRACE_MS = 5_000

/** `allPages` 时默认最多翻多少页 tools/list。 */
export const DEFAULT_MAX_TOOL_PAGES = 100

/** 调用方能要到的最多页数。 */
export const MAX_TOOL_PAGES = 1_000

/** 一次 tools/list 累计能收多少个工具，超过判对端违约。 */
export const MAX_TOTAL_TOOLS = 1_000

/** 单行 JSON-RPC 的字节上限（16 MiB）。超限的那一行整行丢弃，见 frames.ts。 */
export const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024

/**
 * 一个进程生命周期内允许用掉的会话令牌数。
 *
 * 令牌只进不出（用过的永久进 tombstone），所以这是个硬顶而不是并发数上限：到顶只能重启应用。
 * Rust 侧同样如此，错误文案里也是这么说的。
 */
export const MAX_SESSION_TOKENS = 10_000

// Rust 的 `CHILD_WAIT_POLL_MS = 10` **没有对应物**：那是 `try_wait()` 轮询的间隔，
// 而 Node 这边等的是 `child` 的 'exit' 事件，没有轮询这回事。少一个常量不是漏移植。
