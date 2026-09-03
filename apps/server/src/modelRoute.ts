// `POST /api/model/request`：模型代理的**流式**端点。
// ---------------------------------------------------------------------------
// 【为什么它不在 `/api/invoke/:command` 下】
// 那条统一路由的返回值被一层 JSON 信封包住（`replyJson(response, 200, result ?? null)`），装不下
// 一条流。M1 因此**故意没有**把 `model_provider_request` 放进命令路由表——写一个「攒完再返回」的
// handler 会造出「看起来能流式、实际等模型全部生成完才吐一个字」的假象，而这个假象在开发机上
// （响应快）根本看不出来。真正的出口是 `forwardProviderRequest`，本模块直接调它并把
// `AsyncGenerator<Uint8Array>` 逐块写进 HTTP 响应。
//
// 【认证：在本模块之前，不在本模块之内】
// 本端点在 `/api/*` 下，而 `requestRouter.ts` 的 `handleApi` **第一行**就是认证卡口
// （回环对端地址 → Host → Origin → token），路径分派在它之后。所以接线只要把分支加在
// `handleApi` 里，认证就自动套上了；**分支内不要再判一遍**。唯一的 token 豁免是
// `/api/health`（S2 的裁决，为了 B1 的宿主探测），本端点不是它，因此每一条请求都要带
// `Authorization: Bearer <token>`。`modelRoute.test.ts` 里有一条用例把这两件事钉成断言，
// 免得将来有人把路径挪出 `/api/` 前缀而不自知。
//
// 【失败分界线：响应头有没有交出去】（M1 定的，本模块照做）
//   · 交出去**之前**失败 → `forwardProviderRequest` reject → `modelRouteError.ts` 映射成一条
//     正常的 HTTP 错误响应（`{ error, message }` 信封，与本 API 面其余部分同形）。
//   · 交出去**之后**失败 → 从 generator 抛 `ModelProxyStreamError` / `ModelRequestCancelledError`
//     → 状态码已经写给客户端了，改不回来，**唯一诚实的处理是断连**（`response.destroy()`）。
//     客户端因此把这次响应判成不完整，而不是「一次成功但内容被截断」。
//     issue 树 findings #22 点名的两种「响应过大」正是分居这条线两侧：上游**声明**的
//     content-length 超限在响应头之前（→ 502），流中**累计**超限在响应头之后（→ 断连）。
//     它们不塌成一种，靠的就是这条分界线本身。
//
// 【`release()` 的四条路径】拿到响应头却不消费时，generator 的 `finally` 一次都不会跑，在飞请求
// 表会留下一条永远销不掉的账（内存泄漏 + 那次请求再也取消不掉）。所以：
//   ① 客户端在 `forwardProviderRequest` 返回之后、我们开始消费之前就断了 → `watch.adopt()`
//      当场补一次 release（这正是「一次都没消费过」那种形态）；
//   ② 客户端在流中途断了 → `watch` 的 close 监听器立刻 release，不等下一个 chunk；
//   ③ 流里抛错、或写响应出错 → 下面那个 `finally`；
//   ④ 正常读完 → 同一个 `finally`。
// ③④ 合用一个**无条件**的 `finally`：正确性不该依赖「每条路径都有人记得调」这种枚举，而
// `release()` 在已经收尾的响应上是幂等的（`finish` 是一次 Map 删除，`reader.cancel()` 在已结束
// 的流上直接 resolve）。
// 还有两条**不经过 release** 的收尾，各有各的机制，别把它们也算成 release 的路径：
//   · `forwardProviderRequest` 自己 reject（响应头之前失败）→ 不存在可 release 的对象，
//     M1 已经在内部销过账；
//   · 客户端在**响应头还没交出来**时就断了 → 那一刻手里还没有对象，唯一的把手是按 requestId
//     在飞请求表上取消（`cancelInFlightModelRequest`，与 `cancel_model_provider_request` 命令
//     同一张表）。少了它，上游那次生成会一直跑到 120 秒超时才停。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { forwardProviderRequest, modelRequestRegistry } from '@einfach-agent/host-node'
import { replyJson } from './httpReply'
import {
  DEFAULT_MAX_MODEL_BODY_BYTES,
  readModelRouteBody,
} from './modelRouteBody'
import { hasJsonContentType } from './jsonContentType'
import { mapModelRouteError } from './modelRouteError'
import {
  cancelInFlightModelRequest,
  pipeModelResponse,
  watchClientConnection,
} from './modelRouteStream'

// 路径判定住 modelRoutePath.ts（`requestRouter.ts` 只要判据，不该为此把转发实现拉进模块图）；
// 这里再导一次，是为了让「本路由的公开面」只有一个入口，与 invokeRoute.ts 的做法一致。
export { isModelRoutePath, MODEL_ROUTE_PATH } from './modelRoutePath'

/**
 * `forwardProviderRequest` 的第二个参数（宿主装配槽 + 测试注入的 fetch / 在飞请求表）。
 *
 * 从函数签名上取而不是 `import type { ForwardProviderRequestDeps }`：那个名字今天没有出现在
 * `@einfach-agent/host-node` 的**包级**公开面上（只从 `src/model/index.ts` 出去），而深路径 import
 * 在 `tsconfig.app.json` 里解析不了（`@einfach-agent/host-node` 只映射到 barrel）。
 * 这么取的好处是它跟着 M1 的签名走，M1 改了这里是编译错误而不是悄悄漂移。
 */
export type ModelForwardDeps = Parameters<typeof forwardProviderRequest>[1]

export interface ModelRouteOptions {
  /** 宿主装配槽，装配层给 `{ options: { homeDir } }`；测试再注入 `fetchImpl` / `registry`。 */
  readonly forward: ModelForwardDeps
  /** 请求体字节上限，默认 `DEFAULT_MAX_MODEL_BODY_BYTES`（56 MiB）。 */
  readonly maxBodyBytes?: number
}

/** 无路径参数，所以不像 `InvokeRouteHandler` 那样收 pathname。 */
export type ModelRouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** 与 `requestRouter.ts` / `invokeRoute.ts` 同形的失败信封：`error` 给程序看，`message` 给人看。 */
function replyApiError(response: ServerResponse, statusCode: number, error: string, message: string): void {
  replyJson(response, statusCode, { error, message })
}

export function createModelRouteHandler(options: ModelRouteOptions): ModelRouteHandler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_MODEL_BODY_BYTES

  return async (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      replyApiError(response, 405, 'method_not_allowed', '模型请求只接受 POST 请求。')
      return
    }
    // 与 invoke 路由同一道防线：`<form>` 设不出 application/json，于是表单发起的跨站 POST
    // 连请求都发不对；这一道不依赖 `Origin` 头存在（S2 对没带 Origin 的请求是放行的）。
    if (!hasJsonContentType(request)) {
      replyApiError(
        response,
        415,
        'unsupported_media_type',
        'Content-Type 必须是 application/json（可带 charset 参数）。',
      )
      return
    }

    const body = await readModelRouteBody(request, maxBodyBytes)
    if (body.kind === 'too-large') {
      replyApiError(response, 413, 'payload_too_large', `请求体超过 ${maxBodyBytes} 字节上限。`)
      return
    }
    if (body.kind === 'invalid-json') {
      replyApiError(response, 400, 'invalid_json', '请求体不是合法的 JSON。')
      return
    }

    // 必须在转发之前装上：上游握手那几秒里客户端就可能走掉，而那时手里还没有可 release 的对象
    // ——那一段的唯一把手是按 requestId 在飞请求表上取消（与 cancel 命令同一张表）。
    const registry = options.forward.registry ?? modelRequestRegistry
    const watch = watchClientConnection(response, () => {
      cancelInFlightModelRequest(registry, body.value)
    })
    try {
      // 收窄、白名单、取消登记、取 Key、发上游——全在 M1 那一层，本层一个字节都不解析。
      const forwarded = await forwardProviderRequest(body.value, options.forward)
      watch.adopt(forwarded)
      try {
        await pipeModelResponse(forwarded, response, watch)
      } finally {
        await forwarded.release()
      }
    } catch (error) {
      if (response.headersSent) {
        // 响应头之后的失败：状态码改不回来了，只能断连。**不写任何错误正文**——半条 JSON 追在
        // 模型输出后面只会被当成模型说的话。
        response.destroy()
        return
      }
      // 客户端已经走了：这条响应没有听众，往一条断掉的 socket 上写只会换来一次无关的异常。
      if (watch.gone) return
      const mapped = mapModelRouteError(error)
      replyApiError(response, mapped.statusCode, mapped.error, mapped.message)
    } finally {
      watch.dispose()
    }
  }
}
