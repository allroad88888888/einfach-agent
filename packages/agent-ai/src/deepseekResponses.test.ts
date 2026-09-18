import { describe, expect, it, vi } from 'vitest'
import { callDeepSeek, streamDeepSeek } from './deepseek'

const messages = [
  {
    role: 'assistant' as const,
    content: '',
    reasoning_content: 'inspect',
    tool_calls: [{
      id: 'call-view', type: 'function' as const,
      function: { name: 'view_image', arguments: '{"path":"red.png"}' },
    }],
  },
  {
    role: 'tool' as const,
    tool_call_id: 'call-view',
    content: '{"path":"red.png"}',
    model_content: [
      { type: 'text' as const, text: '{"path":"red.png"}' },
      {
        type: 'image' as const,
        source: { kind: 'inline-base64' as const, data: 'UkVE' },
        name: 'red.png', mimeType: 'image/png', byteSize: 3,
      },
    ],
  },
]

function payload() {
  return {
    id: 'resp-1',
    model: 'deepseek-flash',
    status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'The image is red.' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'RED' }] },
    ],
    usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
  }
}

describe('DeepSeek Responses transport', () => {
  it('routes structured tool images to /responses and maps the final response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload()), {
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callDeepSeek(
      { model: 'deepseek-flash', messages },
      { apiKey: 'key', baseUrl: 'https://deepseek.test/v1', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://deepseek.test/v1/responses')
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'deepseek-flash', stream: false,
    })
    expect(result).toEqual({
      id: 'resp-1', model: 'deepseek-flash',
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'RED', reasoning_content: 'The image is red.' },
      }],
    })
  })

  it('streams semantic text and reasoning deltas, then returns the terminal response', async () => {
    const source = [
      'data: {"type":"response.reasoning_text.delta","delta":"The image "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"RED"}\n\n',
      `data: ${JSON.stringify({ type: 'response.completed', response: payload() })}\n\n`,
    ].join('')
    const deltas: unknown[] = []
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(source, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }))

    const result = await streamDeepSeek(
      { model: 'deepseek-flash', messages },
      { apiKey: 'key', baseUrl: 'https://deepseek.test/v1', fetchImpl, retry: { maxRetries: 0 } },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(deltas).toEqual([
      { reasoning_content: 'The image ' },
      { content: 'RED' },
    ])
    expect(result.choices?.[0]?.message?.content).toBe('RED')
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true })
  })

  it('keeps ordinary text requests on Chat Completions', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    })))

    await callDeepSeek(
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] },
      { apiKey: 'key', baseUrl: 'https://deepseek.test/v1', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://deepseek.test/v1/chat/completions')
  })

  it('does not send tool images to a DeepSeek model without vision support', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    })))

    await callDeepSeek(
      { model: 'deepseek-v4-pro', messages },
      { apiKey: 'key', baseUrl: 'https://deepseek.test/v1', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://deepseek.test/v1/chat/completions')
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(body.messages[1]).not.toHaveProperty('model_content')
    expect(body.messages[1].content).toContain('当前模型看不到图片内容')
  })

  it('maps incomplete output to the Core truncation reason', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ...payload(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    }), { headers: { 'Content-Type': 'application/json' } }))

    const result = await callDeepSeek(
      { model: 'deepseek-flash', messages },
      { apiKey: 'key', baseUrl: 'https://deepseek.test/v1', fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(result.choices?.[0]?.finish_reason).toBe('length')
  })

  it('rejects failed responses without exposing the provider error message', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'resp-failed', status: 'failed',
      error: { type: 'server_error', message: 'secret request contents' },
    }), { headers: { 'Content-Type': 'application/json' } }))

    await expect(callDeepSeek(
      { model: 'deepseek-flash', messages },
      { apiKey: 'key', baseUrl: 'https://deepseek.test/v1', fetchImpl, retry: { maxRetries: 0 } },
    )).rejects.toThrow('DeepSeek Responses failed (response_failed).')
  })
})
