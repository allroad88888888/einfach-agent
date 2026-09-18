import { describe, expect, it } from 'vitest'
import { prepareDeepSeekResponsesRequest } from './deepseekResponsesProtocol'
import type { DeepSeekChatRequest } from './deepseek'

const image = {
  type: 'image' as const,
  source: { kind: 'inline-base64' as const, data: 'UkVE' },
  name: 'red.png',
  mimeType: 'image/png',
  byteSize: 3,
  detail: 'original' as const,
}

describe('DeepSeek Responses request projection', () => {
  it('maps a tool image and full stateless tool history without mutating chat items', () => {
    const request: DeepSeekChatRequest = {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'inspect it' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'I should inspect the image.',
          tool_calls: [{
            id: 'call-view', type: 'function',
            function: { name: 'view_image', arguments: '{"path":"red.png"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call-view',
          content: '{"path":"red.png","detail":"high"}',
          model_content: [
            { type: 'text', text: '{"path":"red.png","detail":"high"}' },
            image,
          ],
        },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'view_image', description: 'View an image',
          parameters: { type: 'object' },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'view_image' } },
      thinking: { type: 'disabled' },
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.8,
      user_id: 'wa_user_1',
    }
    const before = structuredClone(request)

    expect(prepareDeepSeekResponsesRequest(request)).toEqual({
      model: 'deepseek-flash',
      input: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'inspect it' },
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'I should inspect the image.' }],
        },
        {
          type: 'function_call', call_id: 'call-view', name: 'view_image',
          arguments: '{"path":"red.png"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call-view',
          output: [
            { type: 'input_text', text: '{"path":"red.png","detail":"high"}' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,UkVE',
              detail: 'original',
            },
          ],
        },
      ],
      tools: [{
        type: 'function', name: 'view_image', description: 'View an image',
        parameters: { type: 'object' },
      }],
      tool_choice: { type: 'function', name: 'view_image' },
      reasoning: { effort: 'none' },
      temperature: 0.2,
      top_p: 0.8,
      max_output_tokens: 128,
      user: 'wa_user_1',
      stream: undefined,
    })
    expect(request).toEqual(before)
  })

  it('maps uploaded user images to file_id in Responses', () => {
    const projected = prepareDeepSeekResponsesRequest({
      model: 'deepseek-flash',
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: {
            kind: 'provider-file', provider: 'deepseek',
            scope: 'deepseek:default', reference: 'file-api-one',
          },
          name: 'one.png', mimeType: 'image/png', byteSize: 3,
        }],
      }],
    })

    expect(projected.input).toEqual([{
      role: 'user', content: [{ type: 'input_image', file_id: 'file-api-one' }],
    }])
  })
})
