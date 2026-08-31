import { describe, expect, it } from 'vitest'
import { callKimi } from './kimi'
import { callModel } from './modelAdapter'

function jsonResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('Kimi non-stream adapter', () => {
  it('defaults to CN, omits Thinking, and omits fixed sampling fields', async () => {
    let requestedUrl = ''
    let requestBody: Record<string, unknown> = {}
    await callKimi(
      {
        model: 'kimi-k3',
        messages: [
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'reason',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'answer' },
        ],
        thinking: { type: 'enabled' },
        temperature: 0.4,
        top_p: 0.8,
        presence_penalty: 0.2,
        frequency_penalty: 0.1,
      },
      {
        apiKey: 'key',
        retry: { maxRetries: 0 },
        fetchImpl: async (input, init) => {
          requestedUrl = String(input)
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse()
        },
      },
    )

    expect(requestedUrl).toBe('https://api.moonshot.cn/v1/chat/completions')
    expect(requestBody).toMatchObject({
      model: 'kimi-k3',
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', reasoning_content: 'reason' },
        { role: 'tool', tool_call_id: 'call-1', content: 'answer' },
      ],
    })
    expect(requestBody).not.toHaveProperty('temperature')
    expect(requestBody).not.toHaveProperty('top_p')
    expect(requestBody).not.toHaveProperty('presence_penalty')
    expect(requestBody).not.toHaveProperty('frequency_penalty')
    expect(requestBody).not.toHaveProperty('thinking')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
  })

  it('routes global Kimi settings through modelAdapter', async () => {
    let requestedUrl = ''
    let requestBody: Record<string, unknown> = {}
    await callModel(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'disabled' },
        settings: { vendor: 'kimi', region: 'global' },
      },
      {
        apiKey: 'key',
        retry: { maxRetries: 0 },
        fetchImpl: async (input, init) => {
          requestedUrl = String(input)
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse()
        },
      },
    )
    expect(requestedUrl).toBe('https://api.moonshot.ai/v1/chat/completions')
    expect(requestBody).not.toHaveProperty('thinking')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
    expect(requestBody).not.toHaveProperty('user_id')
  })
})
