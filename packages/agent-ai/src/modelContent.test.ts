import { describe, expect, it } from 'vitest'
import {
  userMessageLabel,
  userMessageText,
  userMessageTracePreview,
  userMessageVersion,
} from './modelContent'
import type { UserMessageContent } from './modelProtocol'

const CONTENT: UserMessageContent = [
  { type: 'text', text: 'look ' },
  {
    type: 'image',
    source: {
      kind: 'provider-file',
      provider: 'kimi',
      scope: 'kimi:cn',
      reference: 'ms://private-reference',
    },
    name: 'one.png',
    mimeType: 'image/png',
    byteSize: 12,
  },
  { type: 'text', text: 'here' },
]

describe('provider-neutral user content projections', () => {
  it('preserves legacy strings and extracts structured text', () => {
    expect(userMessageText('legacy')).toBe('legacy')
    expect(userMessageText(CONTENT)).toBe('look here')
    expect(userMessageLabel(CONTENT)).toBe('look here')
  })

  it('labels image-only content without exposing its reference to traces', () => {
    const imageOnly = typeof CONTENT === 'string' ? [] : [CONTENT[1]!]
    expect(userMessageLabel(imageOnly)).toBe('图片对话')
    const trace = userMessageTracePreview(CONTENT)
    expect(trace).toEqual({ text: 'look here', imageCount: 1 })
    expect(JSON.stringify(trace)).not.toMatch(/kimi|private-reference|scope|provider/)
  })

  it('includes ordered opaque references in stable content identity', () => {
    expect(userMessageVersion(CONTENT)).toContain('ms://private-reference')
    const reversed = typeof CONTENT === 'string' ? CONTENT : [...CONTENT].reverse()
    expect(userMessageVersion(reversed)).not.toBe(userMessageVersion(CONTENT))
  })
})
