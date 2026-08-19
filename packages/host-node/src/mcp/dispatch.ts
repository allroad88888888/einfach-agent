// 一条 JSON-RPC 消息该往哪去：响应回给等它的人，通知交给生命周期，请求当场回一句
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_protocol.rs（已随 T1 删除）的 `handle_protocol_value` / `handle_server_request`
// / `parse_rpc_error`。本模块**不认识 MCP 的业务语义**（不知道什么是 tools/list、不解析工具），
// 它只按 JSON-RPC 2.0 的形状分三类：响应、通知、请求。业务在 session.ts / toolOperations.ts。
//
// 几处「看起来像小题大做、其实是照搬」的判据，逐条写明理由——它们都是移植时最容易顺手"改进"、
// 改完就与桌面端行为分叉的地方。

import type { McpLifecycleNotifier } from './lifecycle'
import type { PendingRequests, RpcFailure } from './pending'
import type { McpStdinWriter } from './writer'

/** JSON-RPC 内部错误码，对端没给 code 时的兜底。 */
const INTERNAL_ERROR = -32603
/** JSON-RPC「方法不存在」，用于回绝对端发来的、本客户端不实现的请求。 */
const METHOD_NOT_FOUND = -32601

export interface DispatchContext {
  writer: McpStdinWriter
  pending: PendingRequests
  lifecycle: McpLifecycleNotifier
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  // 载荷来自对端，用 `Object.prototype.hasOwnProperty.call` 而不是 `key in record`：
  // 后者会顺着原型链找，`'constructor' in {}` 是 true。这里查的键（method/id/error/result）
  // 恰好都不在 Object.prototype 上，所以今天没有可利用面——写成安全形态是为了以后加键的人。
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 分发一条已解析的 JSON 值。数组是 JSON-RPC 的批消息，逐条递归。 */
export function dispatchProtocolValue(value: unknown, context: DispatchContext): void {
  if (Array.isArray(value)) {
    for (const message of value) dispatchProtocolValue(message, context)
    return
  }
  if (!isRecord(value)) return

  // `method` 必须**是字符串**才算「这是一条请求或通知」。Rust 写的是
  // `.get("method").and_then(Value::as_str)`——`{"method": 7, "id": 1, "result": {}}` 因此走
  // 响应分支而不是请求分支。看着荒诞，但收严会让一条本该被投递的响应被当成请求、原请求挂到超时。
  const method = value.method
  if (typeof method === 'string') {
    if (hasOwn(value, 'id')) {
      // 带 id = 请求，**必须回一句**，否则对端会一直等。注意判的是「键存在」而不是「id 有值」：
      // `{"method":"ping","id":null}` 在 JSON-RPC 里是个（不规范的）请求，Rust 照样回，回的
      // id 也照样是 null——原样把 id 送回去是应答的定义，不是我们该纠正的地方。
      respondToServerRequest(method, value.id, context.writer)
    } else if (method === 'notifications/tools/list_changed') {
      context.lifecycle.toolsChanged()
    }
    // 其余通知（notifications/message 之类）**有意不做任何事**：既不回应答（通知不该有应答），
    // 也不记日志。Rust 那行注释写的就是这个意思。
    return
  }

  // 到这里是响应。id 必须是非负整数——请求 id 是本客户端自己发的自增序号，别的形状不可能
  // 对应任何在途请求。Rust 用 `as_u64`，字符串 id 因此被静默忽略，照搬。
  const id = value.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return

  // 没人在等 = 超时后迟到的响应，或对端凭空发的。丢弃，不报错：那条请求早已以 timeout 结束，
  // 此刻再制造一个错误只会污染下一次调用。
  context.pending.settle(id, toReply(value))
}

function toReply(
  message: Record<string, unknown>,
): { kind: 'result'; value: unknown } | { kind: 'error'; failure: RpcFailure } {
  // 判的是**键存在**而不是值真假：`{"error": null}` 在 Rust 里是 `Some(Value::Null)`，走 error
  // 分支并落到 parse_rpc_error 的全套兜底。写成 `if (message.error)` 会把它当成没有 error，
  // 转而去看 result——两个宿主对同一条畸形响应给出不同结论。
  if (hasOwn(message, 'error')) return { kind: 'error', failure: parseRpcError(message.error) }
  if (hasOwn(message, 'result')) return { kind: 'result', value: message.result }
  return {
    kind: 'error',
    failure: {
      code: INTERNAL_ERROR,
      message: 'response contains neither result nor error',
      data: undefined,
    },
  }
}

/** 对端 error 对象的三个字段，各自带兜底。非对象（对端发了个字符串）时三项全部走兜底。 */
function parseRpcError(value: unknown): RpcFailure {
  const record = isRecord(value) ? value : {}
  const code = record.code
  const message = record.message
  return {
    code: typeof code === 'number' && Number.isInteger(code) ? code : INTERNAL_ERROR,
    message: typeof message === 'string' ? message : 'unknown JSON-RPC error',
    data: record.data,
  }
}

/**
 * 回绝（或应答）对端发来的请求。
 *
 * 只实现 `ping`——这是**协议要求客户端必答**的那一条，答它不构成实现别的服务端能力。
 * 其余一律 -32601，而不是不理：不理的话对端会挂在那条请求上直到它自己超时，
 * 而一个卡住的 server 表现出来是「我们的 tools/call 全部超时」。
 *
 * 写失败**有意吞掉**（Rust 是 `let _ = write_json_line(...)`）：这条应答是在读取回调里顺手发的，
 * 此刻 stdin 写不进去只说明连接已经在塌了，让它把读取循环也一并掀翻毫无益处——真正的关闭
 * 会由 stdout EOF / 进程退出那两条路正常走完。
 */
function respondToServerRequest(method: string, id: unknown, writer: McpStdinWriter): void {
  const response = method === 'ping'
    ? { jsonrpc: '2.0', id, result: {} }
    : {
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: `client method \`${method}\` is not supported` },
      }
  void writer.write(response).catch(() => {})
}
