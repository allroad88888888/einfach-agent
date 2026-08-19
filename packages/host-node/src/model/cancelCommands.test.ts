import { describe, expect, it } from 'vitest'
import { createCancelModelRequestHandler } from './cancelCommands'
import { forwardProviderRequest } from './forwardRequest'
import { createModelRoutes } from './index'
import { chatEnvelope, useModelTestContext } from './modelTestContext.testHarness'
import { type FakeUpstream, type UpstreamRequestRecord } from './upstreamServer.testHarness'

const context = useModelTestContext()

/**
 * 一台**永不结束**的假上游：写一块就挂着。
 *
 * 「取消真的中断了上游」只有在这种上游上才证得出来——上游自己会结束的话，流断掉可能只是它写完了。
 */
function endlessUpstream(): Promise<FakeUpstream> {
  return context.upstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: 1\n\n')
  })
}

describe('取消真的中断上游', () => {
  it('cancel 命令一发，上游那一头当场看到请求被中止', async () => {
    // 判据不是「我们把它标记成已取消」，而是**上游 socket 那一头**观察到连接在响应写完之前
    // 就断了。用真服务 + 真 fetch 才有这个观测点。
    const fake = await endlessUpstream()
    const cancel = createCancelModelRequestHandler(
      'cancel_model_provider_request',
      context.registry,
    )

    const response = await forwardProviderRequest(chatEnvelope(), context.deps(fake))
    const iterator = response.body[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe('data: 1\n\n')

    await expect(cancel({ requestId: 'request-1' })).resolves.toBe(true)
    await expect(iterator.next()).rejects.toThrow('模型请求已取消')

    await expect((fake.received[0] as UpstreamRequestRecord).aborted).resolves.toBe(true)
    // 请求走完（这里是被取消）之后表必须回到空，否则每取消一次就漏一条。
    expect(context.registry.activeCount).toBe(0)
  })

  it('取消一个还没开始读的响应也断上游——release 是那条路上的收尾', async () => {
    // M2 会遇到这一幕：响应头拿到了、客户端就断了，那个 generator 一次 next() 都没有过。
    // generator 的 finally 在没启动过时压根不会跑，所以收尾必须有第二条路。
    const fake = await endlessUpstream()

    const response = await forwardProviderRequest(chatEnvelope(), context.deps(fake))
    await response.release()

    await expect((fake.received[0] as UpstreamRequestRecord).aborted).resolves.toBe(true)
    expect(context.registry.activeCount).toBe(0)
  })

  it('同一个 requestId 还在飞时，第二次转发是受控失败', async () => {
    // 覆盖会让先前那次请求从此取消不掉——它还在跑、还在花 token，而调用方手里的 ID 已经指向
    // 另一个人。
    const fake = await endlessUpstream()
    context.registry.register('request-1')
    await expect(
      forwardProviderRequest(chatEnvelope(), context.deps(fake)),
    ).rejects.toThrow('模型请求 ID 已存在')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('两条 cancel 命令', () => {
  it('registrar 只交出这两条', () => {
    // 请求转发不在路由表里（它的响应是一条流，`/api/invoke/:command` 的返回值装不下），
    // 缺席 = 分发层报「尚未实现」，那是准确的答复。详见 index.ts 的文件头。
    const table = createModelRoutes({})
    expect(Object.keys(table).sort()).toEqual([
      'cancel_model_chat_completions',
      'cancel_model_provider_request',
    ])
  })

  it('入参是 camelCase 的 requestId——全表 28 条里仅有的两个例外', async () => {
    const cancel = createCancelModelRequestHandler(
      'cancel_model_provider_request',
      context.registry,
    )
    context.registry.register('request-1')
    // 照 workspace 那批的习惯写成 snake_case 时，这里报的是「缺参数」而不是静默返回 false。
    await expect(cancel({ request_id: 'request-1' })).rejects.toThrow(
      'cancel_model_provider_request 缺少 requestId 参数',
    )
    await expect(cancel({ requestId: 'request-1' })).resolves.toBe(true)
  })

  it('取消一个不存在的 ID 是无害的 no-op，格式非法才抛', async () => {
    const cancel = createCancelModelRequestHandler(
      'cancel_model_chat_completions',
      context.registry,
    )
    await expect(cancel({ requestId: 'never-registered' })).resolves.toBe(false)
    await expect(cancel({ requestId: 'bad id' })).rejects.toThrow('模型请求 ID 无效')
    // 数字 ID 不许被 String() 洗成合法字符串：那会把「调用方类型发错了」变成一次查不到的取消。
    await expect(cancel({ requestId: 42 })).rejects.toThrow('模型请求 ID 无效')
  })
})
