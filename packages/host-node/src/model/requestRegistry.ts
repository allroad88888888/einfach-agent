// 在飞的模型请求表：requestId → 这次请求的 AbortController
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_request_registry.rs 的 `ModelRequestCanceller`
// （`Mutex<HashMap<String, CancellationToken>>` → 一张 `Map` + AbortController；Node 单线程，
// 不需要锁）。
//
// ═══ 表的生命周期（本域最容易写出泄漏与幽灵取消的地方）═══
//   register  转发开始时登记。同一个 id 重复登记是**受控失败**，不是覆盖：覆盖会让先前那次
//             请求从此取消不掉——它还在跑、还在花 token，而调用方手里的 id 已经指向另一个人。
//   cancel    可以打在任何时刻，包括请求早就结束之后。不存在的 id 返回 `false` 而**不抛错**：
//             取消是「尽力而为」的语义，前端在收尾竞态里补一发 cancel 是正常现象，让它炸只会
//             把一次无害的迟到变成一条错误日志。（id 本身格式非法仍然抛——那是调用方写错了。）
//   finish    请求真正走完（正常结束 / 出错 / 被取消）时清掉。**不清就是内存泄漏**，而且泄漏的
//             不只是一个 Map 条目：条目扣着一个 AbortController，它上面挂着 fetch 的监听。
//
// 【为什么 finish 挂在「响应流消费完」而不是「函数返回」】桌面侧 `run_provider_request` 是把整个
// 流读完才返回的，所以 `finish` 写在那一句之后就够了。Node 侧 `forwardProviderRequest` 在**拿到
// 响应头**时就返回，流留给调用方（M2）去消费——此时 finish 还不能调用，否则那段时间里 cancel
// 找不到这次请求、中断不了上游。所以 finish 由 forwardRequest.ts 的流收尾（generator 的
// finally）负责，那才是「这次请求确实完了」的时刻。
//
// 【为什么导出一个进程级默认实例】取消命令与转发入口是**两条不同的进入路径**：
// `cancel_model_provider_request` 走命令路由表（S 线的 `/api/invoke/:command`），而请求转发走
// M2 的流式端点（判据明写「不进统一路由」）。两处必须看同一张表，否则取消永远找不到请求。
// 用一个进程级实例是最简单的「同一张表」——requestId 全局唯一（前端用 UUID），共享不会撞。
// 需要隔离的（测试）用 `createModelRequestRegistry()` 现造一个。

import { modelRequestError } from './errors'

/** Rust `MAX_MODEL_REQUEST_ID_BYTES`。 */
const MAX_REQUEST_ID_BYTES = 128

/** Rust `validate_model_request_id`：非空、≤128 字节、只含 ASCII 字母数字与 `-` `_`。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function validateModelRequestId(requestId: unknown): string {
  if (
    typeof requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(requestId)
    || Buffer.byteLength(requestId, 'utf8') > MAX_REQUEST_ID_BYTES
  ) {
    throw modelRequestError('invalidRequestId')
  }
  return requestId
}

export interface ModelRequestRegistry {
  /** 登记一次请求，拿到它的取消把手。id 非法或已在表里都抛错。 */
  register(requestId: string): AbortController
  /**
   * 取消一次在飞的请求。返回它当时是否真在表里。
   *
   * `reason` 会成为 `AbortSignal.reason`，转发层据此区分「用户取消」与「超时」——两者对上游
   * 是同一个动作（断连接），对调用方是两种不同的结果。
   */
  cancel(requestId: string, reason?: unknown): boolean
  /** 请求收尾。不在表里时是无害的 no-op。 */
  finish(requestId: string): void
  /** 当前在飞的数量。只给测试与诊断用——泄漏的唯一可观测形态就是它不回到 0。 */
  readonly activeCount: number
}

export function createModelRequestRegistry(): ModelRequestRegistry {
  const requests = new Map<string, AbortController>()
  return {
    register(requestId) {
      validateModelRequestId(requestId)
      if (requests.has(requestId)) throw modelRequestError('duplicateRequestId')
      const controller = new AbortController()
      requests.set(requestId, controller)
      return controller
    },
    cancel(requestId, reason) {
      validateModelRequestId(requestId)
      const controller = requests.get(requestId)
      if (!controller) return false
      controller.abort(reason)
      return true
    },
    finish(requestId) {
      requests.delete(requestId)
    },
    get activeCount() {
      return requests.size
    },
  }
}

/**
 * 进程级默认表。取消命令与转发入口共用它——理由见文件头「为什么导出一个进程级默认实例」。
 *
 * 模块级单例在本包有先例（webAgentConfigStore.ts 的写入队列），判据一样：这是一件**进程范围
 * 的事实**，按装配实例各持一份只会制造第二个权威，而两份表不一致时的症状是「取消按钮没反应」，
 * 不报错。
 */
export const modelRequestRegistry: ModelRequestRegistry = createModelRequestRegistry()
