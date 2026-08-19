import { describe, expect, it } from 'vitest'
import { forwardProviderRequest } from './forwardRequest'
import {
  chatEnvelope,
  TEST_API_KEY as API_KEY,
  useModelTestContext,
} from './modelTestContext.testHarness'
import { collect } from './upstreamServer.testHarness'

const context = useModelTestContext()

describe('转发一次受限请求', () => {
  it('URL 由白名单拼出，Key 从配置读、只出现在 Authorization 头里', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '2' })
      response.end('data: ok\n\n')
    })

    const response = await forwardProviderRequest(chatEnvelope(), context.deps(fake))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/event-stream')
    expect(response.retryAfter).toBe('2')
    expect(await collect(response.body)).toEqual(Buffer.from('data: ok\n\n'))
    // 调用方给的只是 (provider, scope, method, path)，origin 是本层查表查出来的。
    expect(fake.calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    expect(fake.calls[0]?.init.method).toBe('POST')
    // 不跟随重定向：跟随会让一个被攻陷的上游把带着 Authorization 头的请求引到别处。
    expect(fake.calls[0]?.init.redirect).toBe('manual')
    const received = fake.received[0]
    expect(received?.method).toBe('POST')
    expect(received?.path).toBe('/chat/completions')
    // 正面钉住 Key 确实发出去了——否则下面那条「不外泄」的断言可以靠「压根没读 Key」蒙混过关。
    expect(received?.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(received?.headers.accept).toBe('application/json, text/event-stream')
    expect(received?.headers['content-type']).toBe('application/json')
    expect(received?.body.toString()).toBe('{"model":"deepseek-chat"}')
  })

  it('Key 不出现在成功返回体、失败返回体与任何错误消息里', async () => {
    // 本域是用户模型 API Key 在 Node 侧的唯一读取点，这条用例是那条红线的机械判据。
    const contains = (value: unknown): boolean => JSON.stringify(value ?? null).includes(API_KEY)

    // ① 成功路径：返回值（含响应头）与响应体里都没有 Key。
    const ok = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    const success = await forwardProviderRequest(chatEnvelope(), context.deps(ok))
    expect(contains({ ...success, body: undefined, release: undefined })).toBe(false)
    expect((await collect(success.body)).toString()).not.toContain(API_KEY)

    // ② 上游拒绝：4xx 是**正常返回**（原样透传给调用方），返回体里同样没有 Key。
    const unauthorized = await context.upstream((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"unauthorized"}')
    })
    const rejected = await forwardProviderRequest(
      chatEnvelope({ requestId: 'request-2' }),
      context.deps(unauthorized),
    )
    expect(rejected.status).toBe(401)
    expect((await collect(rejected.body)).toString()).not.toContain(API_KEY)

    // ③ 上游连不上：message、stack、cause 三处都不许带 Key。undici 的 cause 链里会出现请求的
    //    URL 与头部摘要——那是最容易漏出去的地方，所以本层直接丢掉原始 error。
    const dead = await context.upstream(() => undefined)
    await dead.close()
    const failure: unknown = await forwardProviderRequest(
      chatEnvelope({ requestId: 'request-3' }),
      context.deps(dead),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const error = failure as Error
    expect(error.message).toBe('模型服务请求失败')
    expect(`${error.message}${error.stack ?? ''}${String(error)}`).not.toContain(API_KEY)
    expect(contains({ message: error.message, name: error.name, cause: error.cause })).toBe(false)

    // ④ 没配置 Key 时的错误只带展示名，不带键名、不带配置文件路径。
    await context.writeCredentials({})
    const missing: unknown = await forwardProviderRequest(
      chatEnvelope({ requestId: 'request-4' }),
      context.deps(ok),
    ).catch((value: unknown) => value)
    expect((missing as Error).message).toBe('未配置 DeepSeek API Key')
    expect(`${(missing as Error).stack ?? ''}`).not.toContain(API_KEY)
  })

  it('是真流式：第一块到了就能读到，不等上游写完', async () => {
    let releaseSecondChunk: () => void = () => undefined
    const secondChunk = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve
    })
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: 1\n\n')
      void secondChunk.then(() => response.end('data: 2\n\n'))
    })

    const response = await forwardProviderRequest(chatEnvelope(), context.deps(fake))
    const iterator = response.body[Symbol.asyncIterator]()
    // 这一句能拿到值就说明本层没有「攒完再返回」：第二块此刻还没被上游写出来。
    const first = await iterator.next()
    expect(Buffer.from(first.value as Uint8Array).toString()).toBe('data: 1\n\n')

    releaseSecondChunk()
    const rest: Buffer[] = []
    for (let chunk = await iterator.next(); chunk.done !== true; chunk = await iterator.next()) {
      rest.push(Buffer.from(chunk.value))
    }
    expect(Buffer.concat(rest).toString()).toBe('data: 2\n\n')
    expect(context.registry.activeCount).toBe(0)
  })

  it('multipart 端点带着文件字节走 multipart/form-data', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"id":"file-1"}')
    })

    const response = await forwardProviderRequest(
      {
        target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
        body: {
          kind: 'multipart',
          parts: [
            { kind: 'text', name: 'purpose', value: 'file-extract' },
            {
              kind: 'file',
              name: 'file',
              fileName: 'a.png',
              contentType: 'image/png',
              bytesBase64: 'AQID',
            },
          ],
        },
        requestId: 'upload-1',
      },
      context.deps(fake),
    )
    await collect(response.body)

    const received = fake.received[0]
    expect(String(received?.headers['content-type'])).toContain('multipart/form-data; boundary=')
    expect(received?.body.toString('binary')).toContain('filename="a.png"')
    expect(received?.body.includes(Buffer.from([1, 2, 3]))).toBe(true)
  })
})

describe('白名单与收窄发生在读 Key、发请求之前', () => {
  it('目标不在白名单时既不占用 requestId，也不发请求', async () => {
    const fake = await context.upstream((_request, response) => response.end())
    const target = { ...chatEnvelope().target, path: '/embeddings' }
    await expect(
      forwardProviderRequest(chatEnvelope({ target }), context.deps(fake)),
    ).rejects.toThrow('模型请求目标未获允许')
    expect(context.registry.activeCount).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })

  it('信封多带一个字段就整份拒绝', async () => {
    const fake = await context.upstream((_request, response) => response.end())
    await expect(
      forwardProviderRequest({ ...chatEnvelope(), extra: 1 }, context.deps(fake)),
    ).rejects.toThrow('模型请求格式无效')
    expect(context.registry.activeCount).toBe(0)
  })

  it('body 形状与端点不匹配时，已登记的 requestId 会当场销账', async () => {
    const fake = await context.upstream((_request, response) => response.end())
    await expect(
      forwardProviderRequest(chatEnvelope({ body: { kind: 'none' } }), context.deps(fake)),
    ).rejects.toThrow('模型请求格式无效')
    expect(context.registry.activeCount).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})
