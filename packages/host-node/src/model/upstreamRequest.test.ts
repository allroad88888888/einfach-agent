import { describe, expect, it } from 'vitest'
import { forwardProviderRequest } from './forwardRequest'
import { chatEnvelope, useModelTestContext } from './modelTestContext.testHarness'
import { collect, type UpstreamRequestRecord } from './upstreamServer.testHarness'

const context = useModelTestContext()

/** 删除端点的响应上限是 1 MiB——三条聊天端点是 32 MiB，在测试里跑不动。 */
const DELETE_ENVELOPE = {
  target: { provider: 'kimi', scope: 'cn', method: 'DELETE', path: '/files/abc' },
  body: { kind: 'none' },
  requestId: 'delete-1',
}

describe('响应大小上限', () => {
  it('上游声明的 content-length 超限时，响应头都不交出去', async () => {
    const fake = await context.upstream((_request, response) => {
      // 声明 64 MiB，而聊天端点的上限是 32 MiB。
      response.writeHead(200, { 'content-length': String(64 * 1024 * 1024) })
      response.write('x')
    })

    await expect(forwardProviderRequest(chatEnvelope(), context.deps(fake))).rejects.toThrow(
      '模型响应过大',
    )
    expect(context.registry.activeCount).toBe(0)
  })

  it('流中累计超限时从响应体里抛出——响应头已经交出去了，改不回来', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      const chunk = 'x'.repeat(64 * 1024)
      for (let written = 0; written < 20; written += 1) response.write(chunk)
    })

    const response = await forwardProviderRequest(DELETE_ENVELOPE, context.deps(fake))
    expect(response.status).toBe(200)
    await expect(collect(response.body)).rejects.toThrow('模型响应过大')
    expect(context.registry.activeCount).toBe(0)
  })

  it('上游中途断连时报「模型响应中断」', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: 1\n\n')
      // 不走 end()，直接把 socket 掐了：调用方看到的是一条读到一半断掉的流。
      setTimeout(() => response.destroy(), 10)
    })

    const response = await forwardProviderRequest(chatEnvelope(), context.deps(fake))
    await expect(collect(response.body)).rejects.toThrow('模型响应中断')
    expect(context.registry.activeCount).toBe(0)
  })
})

describe('整体超时（Rust MODEL_REQUEST_TIMEOUT_SECONDS 的等价物）', () => {
  it('响应头还没来就超时 → 模型服务请求失败', async () => {
    // 对齐 Rust：这一段超时在那边表现为 reqwest 的 `send()` 返回 Err，报的是「请求失败」。
    const fake = await context.upstream(() => undefined)
    await expect(
      forwardProviderRequest(chatEnvelope(), context.deps(fake, { timeoutMs: 100 })),
    ).rejects.toThrow('模型服务请求失败')
    expect(context.registry.activeCount).toBe(0)
  })

  it('读流读到一半超时 → 模型响应中断，且上游被真的掐断', async () => {
    // 对齐 Rust：这一段超时在那边表现为 chunk 流里的 Err，报的是「响应中断」。
    // 超时覆盖的是**全程**（发请求到读完响应体），所以一条挂着不结束的流也会被收走。
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: 1\n\n')
    })

    const response = await forwardProviderRequest(
      chatEnvelope(),
      context.deps(fake, { timeoutMs: 300 }),
    )
    await expect(collect(response.body)).rejects.toThrow('模型响应中断')
    await expect((fake.received[0] as UpstreamRequestRecord).aborted).resolves.toBe(true)
    expect(context.registry.activeCount).toBe(0)
  })
})
