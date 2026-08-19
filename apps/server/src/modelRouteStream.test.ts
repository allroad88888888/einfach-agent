// 响应那一侧：字节原样透传、真的边到边发、客户端断开能中断上游、响应头之后的失败只能断连。

import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { modelRequestRegistry } from '@einfach-agent/host-node'
import {
  chatEnvelope,
  deleteEnvelope,
  TEST_API_KEY,
  useModelRouteTestContext,
  waitForNoActiveModelRequests,
  waitUntil,
} from './modelRoute.testHarness'
import {
  openModelStream,
  sendModelRequest,
  sendWithoutWaiting,
} from './modelRouteClient.testHarness'

const context = useModelRouteTestContext()

describe('原样透传', () => {
  it('状态码、content-type、retry-after 与响应体逐字透传；Key 只出现在上游那一头', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '2' })
      response.end('data: ok\n\n')
    })
    const port = await context.serve(fake)

    const probe = await sendModelRequest(port, { body: JSON.stringify(chatEnvelope('pass-1')) })

    expect(probe.status).toBe(200)
    expect(probe.headers['content-type']).toBe('text/event-stream')
    expect(probe.headers['retry-after']).toBe('2')
    expect(probe.body).toBe('data: ok\n\n')
    expect(probe.complete).toBe(true)
    // 长度未知就该是 chunked：压一个 content-length 出来意味着这一层攒过。
    expect(probe.headers['content-length']).toBeUndefined()
    expect(probe.headers['transfer-encoding']).toBe('chunked')
    expect(probe.headers['cache-control']).toBe('no-store')

    // ① 先正面钉住 Key 确实发到上游去了——否则下面那条「不外泄」可以靠「压根没读 Key」蒙混过关。
    const upstream = fake.received[0]
    expect(upstream?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`)
    expect(upstream?.body.toString()).toBe('{"model":"deepseek-chat"}')
    expect(fake.calls[0]).toBe('https://api.deepseek.com/chat/completions')
    // ② 浏览器这一侧的每一个字节里都没有它。
    expect(probe.body).not.toContain(TEST_API_KEY)
    expect(JSON.stringify(probe.headers)).not.toContain(TEST_API_KEY)
    await waitForNoActiveModelRequests()
  })

  it('上游的 4xx 是一次正常的透传，不是我们的失败', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"unauthorized"}')
    })
    const port = await context.serve(fake)

    const probe = await sendModelRequest(port, { body: JSON.stringify(chatEnvelope('pass-2')) })

    expect(probe.status).toBe(401)
    expect(probe.body).toBe('{"error":"unauthorized"}')
    expect(probe.complete).toBe(true)
    expect(probe.body).not.toContain(TEST_API_KEY)
  })
})

describe('真的是边到边发，不是攒完再发', () => {
  it('上游只写了第一块、还没 end，浏览器这头就已经拿到那一块了', async () => {
    // 这是本端点存在的全部理由。攒完再返回的实现在开发机上（响应快）看不出任何异常，
    // 只有「上游故意不 end」才能把它逼出来：那种实现下 `openModelStream` 会一直等不到响应头。
    let upstreamResponse: ServerResponse | undefined
    const fake = await context.upstream((_request, response) => {
      upstreamResponse = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: 1\n\n')
    })
    const port = await context.serve(fake)

    const stream = await openModelStream(port, chatEnvelope('live-1'))
    expect(stream.status).toBe(200)
    expect((await stream.next())?.toString()).toBe('data: 1\n\n')

    upstreamResponse?.end('data: 2\n\n')
    const rest = await stream.collect()
    expect(rest.text).toBe('data: 2\n\n')
    expect(rest.complete).toBe(true)
    await waitForNoActiveModelRequests()
  })
})

describe('客户端断开', () => {
  it('关标签页 → 上游 socket 那头观察到请求被中止，在飞请求表也销账', async () => {
    // 判据落在**上游那一头**：`response.on('close')` 且 `writableEnded === false`。
    // 只在我们这边记一个标记位是证明不了「真的中断了上游」的——那正是这条用例要排除的实现。
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: 1\n\n')
      // 之后再也不写：模拟一次长时间的模型生成。断连必须在这段沉默里就生效，
      // 而不是等下一个 chunk 到了才被发现。
    })
    const port = await context.serve(fake)

    const stream = await openModelStream(port, chatEnvelope('abort-1'))
    expect((await stream.next())?.toString()).toBe('data: 1\n\n')
    stream.abort()

    await expect(fake.received[0]?.aborted).resolves.toBe(true)
    await waitForNoActiveModelRequests()
  })

  it('响应头还没交出去就断开 → 上游同样被放掉（generator 一次都没被消费过）', async () => {
    // M1 点名的那个漏：拿到响应头却不消费时 generator 的 `finally` 根本不会跑，`release()` 是
    // 唯一的销账口。这里比上一条更早一步——客户端在上游还没回响应头时就走了，那段时间里
    // `watch` 还没有对象可放，所以「放弃」必须能等到对象到位再兑现（`adopt()` 里那一句）。
    // 上游收到了请求但一个字节都不回，正是长思考模型开头那几十秒的形态。
    const fake = await context.upstream(() => undefined)
    const port = await context.serve(fake)

    const pending = sendWithoutWaiting(port, chatEnvelope('abort-2'))
    await waitUntil(() => fake.received.length > 0, '上游没收到这次请求')
    pending.abort()

    await expect(fake.received[0]?.aborted).resolves.toBe(true)
    await waitForNoActiveModelRequests()
  })
})

describe('取消命令与本端点走同一张在飞请求表', () => {
  it('响应头还没交出来时被取消 → 499 + 模型请求已取消，上游也断了', async () => {
    // 这是 M3 的真实路径：用户点「停止」→ 浏览器发 `cancel_model_provider_request`（走
    // `/api/invoke/:command`），而这条 POST 还挂在这里等上游。两条路必须看同一张表，否则取消
    // 永远找不到请求。这条用例直接拿进程级那张表当「cancel 命令」用，钉住的就是那份共享。
    const fake = await context.upstream(() => undefined)
    const port = await context.serve(fake)

    const pending = openModelStream(port, chatEnvelope('cancel-cmd-1'))
    await waitUntil(() => fake.received.length > 0, '上游没收到这次请求')
    expect(modelRequestRegistry.cancel('cancel-cmd-1')).toBe(true)

    const stream = await pending
    // 499 不是 IANA 注册码，这条同时验证它真能原样写到线上去（Node 对未知码用 'unknown' 作原因短语）。
    expect(stream.status).toBe(499)
    const rest = await stream.collect()
    expect(JSON.parse(rest.text)).toEqual({
      error: 'request_cancelled',
      message: '模型请求已取消',
    })
    await expect(fake.received[0]?.aborted).resolves.toBe(true)
    await waitForNoActiveModelRequests()
  })
})

describe('两种「响应过大」不塌成一种（findings #22）', () => {
  it('上游**声明**的 content-length 超限 → 响应头之前失败 → 一条完整的 502', async () => {
    const fake = await context.upstream((_request, response) => {
      // 声明 64 MiB，而聊天端点的上限是 32 MiB。
      response.writeHead(200, { 'content-length': String(64 * 1024 * 1024) })
      response.write('x')
    })
    const port = await context.serve(fake)

    const probe = await sendModelRequest(port, { body: JSON.stringify(chatEnvelope('cl-1')) })

    expect(probe.status).toBe(502)
    expect(JSON.parse(probe.body)).toEqual({
      error: 'model_request_failed',
      message: '模型响应过大',
    })
    // 完整的一条错误响应：状态码还没写出去的时候我们还能选。
    expect(probe.complete).toBe(true)
    await waitForNoActiveModelRequests()
  })

  it('流中**累计**超限 → 响应头之后失败 → 200 已经发出去了，只能断连', async () => {
    // 同一个原因（响应过大）在两侧的形状必须不同：上面那条能给出 502，这条不能——状态码写出去
    // 就改不回来了。把它也做成 502 需要先把整条流攒起来，那恰好是本端点不能做的事。
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      const chunk = 'x'.repeat(64 * 1024)
      for (let written = 0; written < 20; written += 1) response.write(chunk)
    })
    const port = await context.serve(fake)

    // 删除端点的响应上限是 1 MiB（聊天端点 32 MiB，在测试里跑不动）。
    const probe = await sendModelRequest(port, { body: JSON.stringify(deleteEnvelope('cl-2')) })

    expect(probe.status).toBe(200)
    expect(probe.complete).toBe(false)
    // 断连而不是在模型输出后面追一段 JSON——半条错误正文只会被当成模型说的话。
    expect(probe.body).not.toContain('model_request_failed')
    await waitForNoActiveModelRequests()
  })

  it('上游中途把连接掐了 → 同样是响应头之后，同样只能断连', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: 1\n\n')
      setTimeout(() => response.destroy(), 10)
    })
    const port = await context.serve(fake)

    const probe = await sendModelRequest(port, { body: JSON.stringify(chatEnvelope('cut-1')) })

    expect(probe.status).toBe(200)
    expect(probe.body).toBe('data: 1\n\n')
    expect(probe.complete).toBe(false)
    await waitForNoActiveModelRequests()
  })
})
