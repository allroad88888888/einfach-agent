import { describe, expect, it } from 'vitest'
import { createContextCheckpoint } from './contextDistillation'

function checkpointResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('context distillation request', () => {
  it('omits tool configuration and pairs timed tool history for the checkpoint', async () => {
    let body: Record<string, unknown> | undefined

    const checkpoint = await createContextCheckpoint({
      stablePrefix: [{ role: 'system', content: 'Stable instructions.' }],
      transcript: [
        { role: 'user', content: 'Inspect the project.' },
        { role: 'tool', tool_call_id: 'timed:sessionStart:session_brief', content: 'Skill manifest.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Project details.' },
      ],
      coveredItemIds: ['u1', 'a1', 't1'],
      settings: { vendor: 'deepseek', model: 'deepseek-v4-flash' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return checkpointResponse('Checkpoint created.')
      },
    })

    expect(checkpoint.summary).toBe('Checkpoint created.')
    expect(body).toBeDefined()
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
    ]))
    const messages = body?.messages as Array<Record<string, unknown>>
    const timedResultIndex = messages.findIndex((message) => (
      message.role === 'tool' && message.tool_call_id === 'timed:sessionStart:session_brief'
    ))
    expect(messages[timedResultIndex - 1]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'timed:sessionStart:session_brief',
        function: { name: 'timed_tool_result', arguments: '{}' },
      }],
    })
  })
})
