import { describe, expect, it } from 'vitest'
import { encodeKimiMessages } from './kimiMessages'
import type { UserImageContentBlock } from './modelProtocol'

function image(overrides: Partial<UserImageContentBlock['source']> = {}): UserImageContentBlock {
  return {
    type: 'image',
    source: {
      kind: 'provider-file',
      provider: 'kimi',
      scope: 'kimi:cn',
      reference: 'ms://file-one',
      ...overrides,
    },
    name: 'one.png',
    mimeType: 'image/png',
    byteSize: 10,
  }
}

describe('Kimi message encoding', () => {
  it('preserves text/image order and leaves pure text as a string', () => {
    const encoded = encodeKimiMessages([
      { role: 'user', content: 'plain text' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          image(),
          { type: 'text', text: 'after' },
        ],
      },
    ], 'cn', 'kimi-k3')

    expect(encoded).toEqual([
      { role: 'user', content: 'plain text' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'image_url', image_url: { url: 'ms://file-one' } },
          { type: 'text', text: 'after' },
        ],
      },
    ])
  })

  it('encodes an image-only user turn as a content array', () => {
    expect(encodeKimiMessages([
      { role: 'user', content: [image()] },
    ], 'cn', 'kimi-k3')).toEqual([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'ms://file-one' } }],
      },
    ])
  })

  it('preserves assistant reasoning, tool calls, and tool results', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: null,
        reasoning_content: 'thinking',
        tool_calls: [{
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'lookup', arguments: '{"id":1}' },
        }],
      },
      { role: 'tool' as const, tool_call_id: 'call-1', content: 'result' },
    ]
    expect(encodeKimiMessages(history, 'cn', 'kimi-k3')).toEqual(history)
  })

  it.each([
    ['foreign provider', image({ provider: 'other' }), /cannot consume/],
    ['wrong region', image({ scope: 'kimi:global' }), /does not match request scope/],
    ['invalid URI', image({ reference: 'https:\/\/example.test\/one.png' }), /ms:\/\//],
  ])('rejects %s references', (_label, block, error) => {
    expect(() => encodeKimiMessages(
      [{ role: 'user', content: [block] }],
      'cn',
      'kimi-k3',
    )).toThrow(error)
  })

  it('does not send image references to an unknown Kimi model', () => {
    expect(() => encodeKimiMessages(
      [{ role: 'user', content: [image()] }],
      'cn',
      'kimi-future',
    )).toThrow(/no verified image input protocol/)
  })
})
