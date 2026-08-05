import { describe, expect, it } from 'vitest'
import { streamModel } from './modelAdapter'
import type { ModelStreamDelta } from './modelApi'

function sseResponse(chunks: readonly unknown[]): Response {
  const source = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  return new Response(source, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('Kimi stream adapter', () => {
  it('aggregates reasoning, tool calls, and final usage', async () => {
    const deltas: ModelStreamDelta[] = []
    let requestBody: Record<string, unknown> = {}
    const response = await streamModel(
      {
        model: 'kimi-k2.6',
        messages: [{ role: 'user', content: 'find it' }],
        settings: { vendor: 'kimi' },
      },
      {
        apiKey: 'key',
        retry: { maxRetries: 0 },
        fetchImpl: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return sseResponse([
            {
              id: 'kimi-1',
              model: 'kimi-k2.6',
              choices: [{ delta: { role: 'assistant', reasoning_content: 'think' } }],
            },
            {
              choices: [{ delta: { tool_calls: [{
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'lookup', arguments: '{' },
              }] } }],
            },
            {
              choices: [{
                delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
                finish_reason: 'tool_calls',
              }],
            },
            { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } },
          ])
        },
      },
      { onDelta: (delta) => deltas.push(delta) },
    )

    expect(requestBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(deltas).toHaveLength(3)
    expect(response).toMatchObject({
      usage: { total_tokens: 12 },
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          reasoning_content: 'think',
          tool_calls: [{
            id: 'call-1',
            function: { name: 'lookup', arguments: '{}' },
          }],
        },
      }],
    })
  })
})
