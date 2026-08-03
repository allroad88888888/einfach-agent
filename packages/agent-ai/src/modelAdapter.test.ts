import { describe, expect, it } from 'vitest'
import { callModel, streamModel } from './modelAdapter'

describe('模型 adapter 路由', () => {
  it('GLM 不触发 DeepSeek 容量重试，也不接收 DeepSeek 专属 user_id', async () => {
    let calls = 0
    let requestBody: Record<string, unknown> | undefined
    const retryEvents: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          choices: [{
            finish_reason: 'insufficient_system_resource',
            message: { role: 'assistant', content: null },
          }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const response = await streamModel(
      {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        settings: { vendor: 'glm' },
        userId: 'wa_private-user',
      },
      {
        apiKey: 'test-key',
        baseUrl: 'https://glm.example/v1',
        fetchImpl,
        retry: { maxRetries: 0 },
      },
      undefined,
      { onRetry: ({ status }) => retryEvents.push(status) },
    )

    expect(calls).toBe(1)
    expect(retryEvents).toEqual([])
    expect(requestBody).not.toHaveProperty('user_id')
    expect(response.choices?.[0]?.finish_reason).toBe('insufficient_system_resource')
  })

  it('non-stream calls use the same vendor boundary', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const request = {
      model: 'model',
      messages: [{ role: 'user' as const, content: 'hi' }],
      stream: false,
    }
    const options = {
      apiKey: 'test-key',
      fetchImpl,
      retry: { maxRetries: 0 },
    }

    await callModel({ ...request, settings: { vendor: 'deepseek' }, userId: 'wa_child_0123' }, options)
    await callModel({ ...request, settings: { vendor: 'glm' }, userId: 'wa_child_0123' }, options)

    expect(bodies[0]).toMatchObject({ user_id: 'wa_child_0123', stream: false })
    expect(bodies[1]).not.toHaveProperty('user_id')
    expect(bodies[1]).toMatchObject({ stream: false })
  })
})
