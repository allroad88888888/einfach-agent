// `/api/invoke/:command` 的 handler 工厂：把 body 解析成 args，逐字透传给 host-node 的路由表。
// ---------------------------------------------------------------------------
// 本卡（S3）只交一个可测的 handler 工厂，不接线——`requestRouter.ts` 由并行的 S2 独占（它在
// 往 `handleApi` 装认证卡口）。接进路由是主会话在 S2/S3 都验收完之后统一做的事。
//
// 【逐字透传的边界】判据说 args 逐字透传，但 body 是外部输入——host-node 的 handler 收到的是
// `Record<string, unknown>` 并自己收窄（`commandArgs.ts` 是收窄的目标形状，不是替代品）。
// 这一层要确认的只是「它是个 JSON 对象」，不做逐字段校验，也不给缺失的键填默认值——那会让
// 「进程内注入」与「走 HTTP」两种传输下的键集合差异变得比 core 的 `toTauriInput` 本来就有的那条
// （可选项无值时键存在但值 undefined，`JSON.stringify` 会把它连键一起丢掉）更大。
//
// 【处理顺序】方法 → Content-Type → 命令名解析（不会失败，只是取值）→ body 读取/解析 → invoke。
// 方法与 Content-Type 是「这条路由本身接不接受这次请求」的判断，排在真正触达 host-node 之前。
//
// 【调用方注意：本 handler 是 async】`requestRouter.ts` 的 `handleApi` 今天是同步函数、被同步
// 调用（不 await）——接线时必须把它改成 `async` 并在调用处 `await`，否则这里的 rejection 会变成
// 未捕获的 promise rejection，而不是被现有的外层 try/catch 收成 500。

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostInvoke } from '@einfach-agent/core'
import { NodeHostCommandError } from '@einfach-agent/host-node'
import { replyJson } from './httpReply'
import { hasJsonContentType, readInvokeRouteBody } from './invokeRouteBody'
import { resolveInvokeCommandName } from './invokeRouteCommandName'
import { mapNodeHostCommandError } from './invokeRouteError'

export { isInvokeRoutePath } from './invokeRouteCommandName'

/**
 * 8 MiB（host-node `workspace/write/limits.ts` 的 `MAX_BYTES`，单个文件写入的硬上限）
 * × 1.33（base64 编码二进制内容的膨胀系数）再留给 `apply_workspace_patch` 之类多操作批次的
 * 余量，取整到 32 MiB。这是一个「可选项、缺省有意义」的槽位，不是写死的墙——真要为某种场景
 * 调大/调小，接线时传 `maxBodyBytes` 覆盖即可，不用改这个文件。
 */
export const DEFAULT_MAX_INVOKE_BODY_BYTES = 32 * 1024 * 1024

export interface InvokeRouteOptions {
  /** 已经装配好的命令路由表，通常是 `createNodeHostInvoke(...)` 的返回值。 */
  readonly invoke: HostInvoke
  /** body 字节上限，默认 `DEFAULT_MAX_INVOKE_BODY_BYTES`。 */
  readonly maxBodyBytes?: number
}

export type InvokeRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) => Promise<void>

/** API 面的失败信封，与 `requestRouter.ts` 的 `replyApiError` 同形：`error` 给程序看，`message` 给人看。 */
function replyApiError(response: ServerResponse, statusCode: number, error: string, message: string): void {
  replyJson(response, statusCode, { error, message })
}

export function createInvokeRouteHandler(options: InvokeRouteOptions): InvokeRouteHandler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_INVOKE_BODY_BYTES

  return async (request, response, pathname) => {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      replyApiError(response, 405, 'method_not_allowed', '命令调用只接受 POST 请求。')
      return
    }
    if (!hasJsonContentType(request)) {
      replyApiError(
        response,
        415,
        'unsupported_media_type',
        'Content-Type 必须是 application/json（可带 charset 参数）。',
      )
      return
    }

    const command = resolveInvokeCommandName(pathname)
    const body = await readInvokeRouteBody(request, maxBodyBytes)
    if (body.kind === 'too-large') {
      replyApiError(response, 413, 'payload_too_large', `请求体超过 ${maxBodyBytes} 字节上限。`)
      return
    }
    if (body.kind === 'invalid-json') {
      replyApiError(response, 400, 'invalid_json', '请求体不是合法的 JSON。')
      return
    }
    if (body.kind === 'not-object') {
      replyApiError(response, 400, 'invalid_body', '请求体必须是一个 JSON 对象（命令参数）。')
      return
    }
    const args = body.kind === 'object' ? body.value : {}

    try {
      const result = await options.invoke(command, args)
      // `undefined` 不是合法 JSON，而部分命令确实无返回值；`null` 是它在 JSON 里最贴切的对应。
      // 除此之外原样发出——host-node 的回执有的是 snake_case 有的是 camelCase（施工须知 #12），
      // 这一层不做任何大小写转换。
      replyJson(response, 200, result ?? null)
    } catch (error) {
      if (error instanceof NodeHostCommandError) {
        const mapped = mapNodeHostCommandError(error)
        replyApiError(response, mapped.statusCode, mapped.error, mapped.message)
        return
      }
      // 非路由分发失败（host-node 内部真的出 bug 了）：不在这里猜测怎么回复，重抛给
      // `requestRouter.ts` 现有的外层 try/catch 统一收成 500——那正是它存在的理由。
      throw error
    }
  }
}
