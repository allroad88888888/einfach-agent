import { describe, expect, it } from 'vitest'
import { ModelProxyStreamError, ModelRequestCancelledError } from '@einfach-agent/host-node'
import { mapModelRouteError } from './modelRouteError'

describe('响应头之前的失败怎么映射', () => {
  it('取消 → 499，文案用 M1 已经写好的那句', () => {
    expect(mapModelRouteError(new ModelRequestCancelledError())).toEqual({
      statusCode: 499,
      error: 'request_cancelled',
      message: '模型请求已取消',
    })
  })

  it('其余 → 502，message 原样透传', () => {
    expect(mapModelRouteError(new Error('模型服务请求失败'))).toEqual({
      statusCode: 502,
      error: 'model_request_failed',
      message: '模型服务请求失败',
    })
  })

  it('只取 message，不带 stack / cause / name —— 那是 Key 与上游 URL 泄漏的入口', () => {
    // M1 在上游失败时刻意丢掉原始 error（undici 的 cause 链里有请求 URL 与头部摘要，
    // 而头部里有 Authorization）。本层照同一条纪律，所以映射结果只有三个字段。
    const error = new Error('模型服务请求失败', {
      cause: new Error('connect ECONNREFUSED api.deepseek.com Bearer sk-leak'),
    })
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
    // 也不会退化成 500 或者把对象序列化出去」。
    expect(mapModelRouteError(new ModelProxyStreamError('模型响应过大'))).toEqual({
      statusCode: 502,
      error: 'model_request_failed',
      message: '模型响应过大',
    })
  })
})
