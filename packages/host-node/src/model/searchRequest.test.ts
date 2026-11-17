import { describe, expect, it } from 'vitest'
import { forwardProviderRequest } from './forwardRequest'
import { TEST_API_KEY, useModelTestContext } from './modelTestContext.testHarness'
import { collect } from './upstreamServer.testHarness'

const context = useModelTestContext()
const envelope = {
  target: { provider: 'deepseek', scope: 'default', method: 'POST', path: '/v1/tools/search' },
  body: { kind: 'json', json: JSON.stringify({ query: 'example', count: 5, need_content: true }) },
  requestId: 'search-1',
}

describe('DeepSeek search credential reuse', () => {
  it('forwards to the exact official endpoint with the existing model Key', async () => {
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"results":[]}')
    })
    const response = await forwardProviderRequest(envelope, context.deps(fake))
    expect((await collect(response.body)).toString()).toBe('{"results":[]}')
    expect(fake.calls[0]?.url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(fake.received[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`)
    expect(fake.received[0]?.body.toString()).toBe(envelope.body.json)
    expect(context.registry.activeCount).toBe(0)
  })

  it('uses the existing missing-model-key error without contacting upstream', async () => {
    await context.writeCredentials({})
    const fake = await context.upstream((_request, response) => response.end())
    await expect(forwardProviderRequest(envelope, context.deps(fake)))
      .rejects.toThrow('未配置 DeepSeek API Key')
    expect(fake.calls).toHaveLength(0)
  })

  it.each(['/v1/tools/search/', '/v1/tools/search?key=private', '/v1/tools/fetch'])(
    'does not allow related endpoint %s', async (path) => {
      const fake = await context.upstream((_request, response) => response.end())
      await expect(forwardProviderRequest({ ...envelope, target: { ...envelope.target, path } }, context.deps(fake)))
        .rejects.toThrow('模型请求目标未获允许')
      expect(fake.calls).toHaveLength(0)
    },
  )
})
