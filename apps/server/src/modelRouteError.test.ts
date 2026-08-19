// 「响应头之前的失败」怎么映射：状态码由 `reason` 决定，message 原样透传。
import { describe, expect, it } from 'vitest'
import {
  MODEL_REQUEST_ERROR_REASONS,
  ModelProxyStreamError,
  ModelRequestCancelledError,
  type ModelRequestErrorReason,
} from '@einfach-agent/host-node'
import { mapModelRouteError } from './modelRouteError'

/**
 * 造一个**只带 reason、不带任何真实文案**的失败。
 *
 * 刻意不用 host-node 的错误类：一来这正是「判别只看字段、不看类型身份」那条规矩的现场演示
 * （序列化之后到达的就是这种东西）；二来 message 写成一句无意义的占位，能证明状态码**不是**
 * 从文案里读出来的。
 */
function failure(reason: ModelRequestErrorReason): Error {
  return Object.assign(new Error('placeholder-message'), { reason })
}

/** 每类失败对应的状态码。这张表就是本卡的判据，改它等于改对外契约。 */
const EXPECTED_STATUS: Record<ModelRequestErrorReason, number> = {
  'invalid-request': 400,
  'target-not-allowed': 403,
  'credential-missing': 503,
  'upstream-failed': 502,
  'duplicate-request-id': 409,
  'credential-config-invalid': 500,
  cancelled: 499,
}

describe('四类失败各自的状态码', () => {
  it('格式无效 → 400', () => {
    expect(mapModelRouteError(failure('invalid-request'))).toEqual({
      statusCode: 400,
      error: 'invalid_model_request',
      message: 'placeholder-message',
    })
  })

  it('目标未获允许 → 403', () => {
    expect(mapModelRouteError(failure('target-not-allowed')).statusCode).toBe(403)
    expect(mapModelRouteError(failure('target-not-allowed')).error).toBe('model_target_not_allowed')
  })

  it('没配 Key → 503', () => {
    expect(mapModelRouteError(failure('credential-missing')).statusCode).toBe(503)
    expect(mapModelRouteError(failure('credential-missing')).error).toBe('model_credential_missing')
  })

  it('上游真的挂了 → 502', () => {
    expect(mapModelRouteError(failure('upstream-failed')).statusCode).toBe(502)
    expect(mapModelRouteError(failure('upstream-failed')).error).toBe('model_request_failed')
  })
})

describe('卡面四类之外，代码里真实存在的另外三类', () => {
  it('requestId 撞上一次在飞的请求 → 409，而不是与「格式无效」塌成 400', () => {
    // 换个 id 重发就行，上一次请求还活着——这与「你的请求写错了」是两种不同的补救。
    expect(mapModelRouteError(failure('duplicate-request-id')).statusCode).toBe(409)
  })

  it('宿主自己的 config.json 那一段坏了 → 500，不是 4xx 也不是 502', () => {
    // 不是调用方的错（不能 4xx），也不是上游的错（不能 502），重试无用。
    expect(mapModelRouteError(failure('credential-config-invalid')).statusCode).toBe(500)
  })

  it('取消 → 499', () => {
    // 499 不是 IANA 注册码（nginx 惯例：客户端在服务端应答前就走了）。选它而不是某个标准码，
    // 是因为本端点成功时会把**上游的状态码原样透传**——任何标准码都可能与上游真的返回的那个
    // 撞在一起，而这一条的听众恰恰是刚刚发出取消的那个调用方，它的 fetch 本来就已经 abort 了。
    const error = new ModelRequestCancelledError()
    expect(mapModelRouteError(error)).toEqual({
      statusCode: 499,
      error: 'request_cancelled',
      // 文案用 host-node 已经写好的那句，本层不另组一遍——所以这里比的是它自己，不是一个副本。
      message: error.message,
    })
  })
})

describe('分类面是穷举的', () => {
  it.each(MODEL_REQUEST_ERROR_REASONS)('%s 有一个明确的状态码，不落兜底', (reason) => {
    expect(mapModelRouteError(failure(reason)).statusCode).toBe(EXPECTED_STATUS[reason])
  })

  it('host-node 那头新增一类失败时，这张表会漏——所以两边逐条对齐', () => {
    expect(Object.keys(EXPECTED_STATUS).sort()).toEqual([...MODEL_REQUEST_ERROR_REASONS].sort())
  })
})

describe('状态码只由 reason 决定，与文案无关', () => {
  it('同一个 reason 配任意文案，状态码不变', () => {
    // 这条是本卡的核心不变量：文案是给人看的、会被改措辞，改它不该动状态码。
    for (const message of ['', '模型服务请求失败', 'whatever', '模型请求目标未获允许']) {
      expect(mapModelRouteError(Object.assign(new Error(message), { reason: 'target-not-allowed' }))
        .statusCode).toBe(403)
    }
  })

  it('文案对得上但没有 reason → 落兜底 502，不靠文案认领', () => {
    // 这一条正面钉住「apps/server 不按文案分支」：一个 message 与 host-node 逐字相同、却没有
    // reason 的错误（比如别的库抛上来的），必须落兜底，而不是被文案"认"成 403/503。
    const looksLikeTargetDenied = new Error('模型请求目标未获允许')
    expect(mapModelRouteError(looksLikeTargetDenied).statusCode).toBe(502)
    const looksLikeMissingKey = new Error('未配置 DeepSeek API Key')
    expect(mapModelRouteError(looksLikeMissingKey).statusCode).toBe(502)
  })

  it('reason 是个不认识的值 → 也落兜底，不猜', () => {
    expect(mapModelRouteError(Object.assign(new Error('x'), { reason: 'made-up' })).statusCode)
      .toBe(502)
  })
})

describe('这一层不泄漏任何东西', () => {
  it('只取 message，不带 stack / cause / name —— 那是 Key 与上游 URL 泄漏的入口', () => {
    // M1 在上游失败时刻意丢掉原始 error（undici 的 cause 链里有请求 URL 与头部摘要，
    // 而头部里有 Authorization）。本层照同一条纪律，所以映射结果只有三个字段。
    const error = Object.assign(
      new Error('模型服务请求失败', {
        cause: new Error('connect ECONNREFUSED api.deepseek.com Bearer sk-leak'),
      }),
      { reason: 'upstream-failed' as const },
    )
    const mapped = mapModelRouteError(error)
    expect(Object.keys(mapped).sort()).toEqual(['error', 'message', 'statusCode'])
    expect(JSON.stringify(mapped)).not.toContain('sk-leak')
    expect(JSON.stringify(mapped)).not.toContain('api.deepseek.com')
  })

  it('非 Error 的抛出物与空文案落到固定兜底句，不把未知值字符串化发出去', () => {
    expect(mapModelRouteError({ secret: 'sk-leak' }).message).toBe('模型请求失败。')
    expect(mapModelRouteError('sk-leak').message).toBe('模型请求失败。')
    expect(mapModelRouteError(new Error('   ')).message).toBe('模型请求失败。')
  })

  it('流错误也能映射，但它在正常路径上到不了这里——响应头已经发出去了', () => {
    // `ModelProxyStreamError` 只从 generator 里抛，那时 `response.headersSent` 为真，
    // `modelRoute.ts` 走的是 `response.destroy()` 分支。这条用例钉住的是「万一它真到了这里，
    // 也不会退化成 500 或者把对象序列化出去」。它的 reason 恒为 upstream-failed。
    const error = new ModelProxyStreamError('模型响应过大')
    expect(mapModelRouteError(error)).toEqual({
      statusCode: 502,
      error: 'model_request_failed',
      message: error.message,
    })
  })
})
