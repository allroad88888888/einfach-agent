// 把 host-node 的 `NodeHostCommandError` 映射成 HTTP 状态码。
// ---------------------------------------------------------------------------
// 判别用 `.reason` 字段，不用 `instanceof` 判子类型细分——`createNodeHostInvoke.ts` 文件头写明
// 了理由：错误要跨 HTTP 边界序列化，未来 sidecar 那条路上类型身份不一定保得住。这里唯一的
// `instanceof NodeHostCommandError`（在 invokeRoute.ts 里）判的是「这是不是一次明确的命令分发
// 失败」，与「按 reason 分派状态码」是两回事——错误对象本身在同一个进程里创建，`instanceof`
// 认得出；一旦要在不同进程/序列化边界之间传递失败信息，才是必须换成看字段的地方。
//
// `message` 直接复用 host-node 已经写好的中文文案，不再自己组一遍——两处各写一份中文文案，
// 后续改一处就会和另一处漂移，而且 host-node 的文案已经把 command 名嵌进去了。

import type { NodeHostCommandError } from '@einfach-agent/host-node'

export interface InvokeRouteErrorReply {
  readonly statusCode: number
  readonly error: string
  readonly message: string
}

export function mapNodeHostCommandError(error: NodeHostCommandError): InvokeRouteErrorReply {
  if (error.reason === 'unknown-command') {
    return { statusCode: 404, error: 'unknown_command', message: error.message }
  }
  return { statusCode: 501, error: 'command_not_implemented', message: error.message }
}
