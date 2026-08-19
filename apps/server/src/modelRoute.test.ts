// 请求那一侧：路径、方法、Content-Type、请求体上限，以及「响应头之前」的失败怎么回。
// 响应那一侧（流式透传、断连、两种响应过大）在 modelRouteStream.test.ts。

import { describe, expect, it } from 'vitest'
import { HEALTH_PATH } from './health'
import { isModelRoutePath, MODEL_ROUTE_PATH } from './modelRoutePath'
import {
  chatEnvelope,
  TEST_API_KEY,
  useModelRouteTestContext,
} from './modelRoute.testHarness'
import { sendModelRequest } from './modelRouteClient.testHarness'

const context = useModelRouteTestContext()

/** 上游只回一句 ok；那些「压根不该走到上游」的用例靠 `received.length` 判。 */
function okUpstream() {
  return context.upstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
}

describe('端点位置', () => {
  it('挂在 /api/* 下且不是 health —— 认证因此由 handleApi 入口全套上', () => {
    // 这两条不是形式主义：S2 的卡口在 `handleApi` 第一行按 `/api/*` 判定，路径分派在它之后，
    // 唯一的 token 豁免是 `/api/health`（为了 B1 的宿主探测）。所以「本端点要不要认证」这件事
    // 完全由它的路径决定——把它挪出 `/api/` 前缀、或起名叫 health，都会在**没有任何编译错误**
    // 的情况下把一条能借用户 API Key 打上游的端点变成公开的。
    expect(MODEL_ROUTE_PATH.startsWith('/api/')).toBe(true)
    expect(MODEL_ROUTE_PATH).not.toBe(HEALTH_PATH)
  })

  it('精确匹配，不吃前缀', () => {
    expect(isModelRoutePath(MODEL_ROUTE_PATH)).toBe(true)
    expect(isModelRoutePath('/api/model/request/extra')).toBe(false)
    expect(isModelRoutePath('/api/model/request/../../secret')).toBe(false)
    expect(isModelRoutePath('/api/model')).toBe(false)
    // 它**不在** `/api/invoke/:command` 之下——那条统一路由的 JSON 信封装不下一条流。
    expect(isModelRoutePath('/api/invoke/model_provider_request')).toBe(false)
  })
})

describe('这条路由本身接不接受这次请求', () => {
  it('非 POST 回 405 并带 allow', async () => {
    const port = await context.serve(await okUpstream())
    const probe = await sendModelRequest(port, { method: 'GET' })
    expect(probe.status).toBe(405)
    expect(probe.headers.allow).toBe('POST')
  })

  it('Content-Type 不是 application/json 回 415，且根本没碰上游', async () => {
    // 表单 CSRF 那道免费防线：`<form>` 只能发三种简单 content-type，设不出 application/json。
    const fake = await okUpstream()
    const port = await context.serve(fake)
    const probe = await sendModelRequest(port, {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(chatEnvelope('ct-1')),
    })
    expect(probe.status).toBe(415)
    expect(fake.received).toHaveLength(0)
  })
})

describe('请求体', () => {
  it('不是合法 JSON 回 400', async () => {
    const port = await context.serve(await okUpstream())
    const probe = await sendModelRequest(port, { body: '{"target":' })
    expect(probe.status).toBe(400)
    expect(JSON.parse(probe.body)).toMatchObject({ error: 'invalid_json' })
  })

  it('空 body 回 400——本端点每次调用都必须带一份信封', async () => {
    const port = await context.serve(await okUpstream())
    const probe = await sendModelRequest(port, { body: '' })
    expect(probe.status).toBe(400)
  })

  it('超字节上限回 413，且没碰上游', async () => {
    // findings #20：Rust 的 56 MiB 上限施加在 IPC 反序列化之后，那时载荷早就整个在内存里了。
    // HTTP 这条路必须在**读**请求体时就截断，所以这里用一个小上限验证那道截断真的在读的路上。
    const fake = await okUpstream()
    const port = await context.serve(fake, { maxBodyBytes: 64 })
    const probe = await sendModelRequest(port, {
      body: JSON.stringify(chatEnvelope('big-1', { body: { kind: 'json', json: 'x'.repeat(4096) } })),
    })
    expect(probe.status).toBe(413)
    expect(JSON.parse(probe.body)).toMatchObject({ error: 'payload_too_large' })
    expect(fake.received).toHaveLength(0)
  })

  it('恰好等于上限的 body 放行——上限是「超过才拒」', async () => {
    const fake = await okUpstream()
    const payload = JSON.stringify(chatEnvelope('exact-1'))
    const port = await context.serve(fake, { maxBodyBytes: Buffer.byteLength(payload, 'utf8') })
    const probe = await sendModelRequest(port, { body: payload })
    expect(probe.status).toBe(200)
  })
})

describe('响应头交出去之前的失败', () => {
  it('信封里有多余字段 → 502 + 模型请求格式无效', async () => {
    // 收窄是 M1 的事（`deny_unknown_fields`），本层一个字节都不解析——往 target 里塞一个 `url`
    // 必须被拒，否则这一层就是个开放代理。
    const fake = await okUpstream()
    const port = await context.serve(fake)
    const probe = await sendModelRequest(port, {
      body: JSON.stringify(chatEnvelope('bad-1', {
        target: {
          provider: 'deepseek',
          scope: 'default',
          method: 'POST',
          path: '/chat/completions',
          url: 'http://127.0.0.1:1/evil',
        },
      })),
    })
    expect(probe.status).toBe(502)
    expect(JSON.parse(probe.body)).toEqual({
      error: 'model_request_failed',
      message: '模型请求格式无效',
    })
    expect(fake.received).toHaveLength(0)
  })

  it('目标不在白名单 → 502 + 模型请求目标未获允许', async () => {
    const fake = await okUpstream()
    const port = await context.serve(fake)
    const probe = await sendModelRequest(port, {
      body: JSON.stringify(chatEnvelope('bad-2', {
        target: { provider: 'deepseek', scope: 'default', method: 'POST', path: '/v1/anything' },
      })),
    })
    expect(probe.status).toBe(502)
    expect(JSON.parse(probe.body)).toEqual({
      error: 'model_request_failed',
      message: '模型请求目标未获允许',
    })
    expect(fake.received).toHaveLength(0)
  })

  it('没配置 Key → 502 + 未配置 DeepSeek API Key，文案里没有键名也没有配置路径', async () => {
    await context.writeCredentials({})
    const port = await context.serve(await okUpstream())
    const probe = await sendModelRequest(port, { body: JSON.stringify(chatEnvelope('nokey-1')) })
    expect(probe.status).toBe(502)
    expect(JSON.parse(probe.body)).toEqual({
      error: 'model_request_failed',
      message: '未配置 DeepSeek API Key',
    })
    expect(probe.body).not.toContain(context.home)
  })

  it('上游连不上 → 502 + 模型服务请求失败，返回体里没有 Key、没有 stack、没有上游 URL', async () => {
    // M1 在这条路径上刻意丢掉原始 error（undici 的 cause 链带着请求 URL 与头部摘要，
    // 而头部里有 Authorization）。本层照同一条纪律：只取 message，不碰 stack / cause。
    const dead = await okUpstream()
    await dead.close()
    const port = await context.serve(dead)
    const probe = await sendModelRequest(port, { body: JSON.stringify(chatEnvelope('dead-1')) })
    expect(probe.status).toBe(502)
    expect(JSON.parse(probe.body)).toEqual({
      error: 'model_request_failed',
      message: '模型服务请求失败',
    })
    expect(probe.body).not.toContain(TEST_API_KEY)
    expect(probe.body).not.toContain('api.deepseek.com')
    expect(probe.body).not.toContain('stack')
  })
})
