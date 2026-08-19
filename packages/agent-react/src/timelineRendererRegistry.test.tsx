import type {
  TimelineMessageItem,
  TimelineReasoningItem,
} from '@einfach-agent/core/timeline'
import { describe, expect, it } from 'vitest'
import {
  createTimelineRendererRegistry,
} from './index'

function MessageRenderer({ item }: { readonly item: TimelineMessageItem }) {
  return <div data-testid="message-renderer">message:{item.id}</div>
}

function ReplacementMessageRenderer({ item }: { readonly item: TimelineMessageItem }) {
  return <div>replacement:{item.id}</div>
}

function ReasoningRenderer({ item }: { readonly item: TimelineReasoningItem }) {
  return <div>reasoning:{item.content}</div>
}

function ReplacementReasoningRenderer({ item }: { readonly item: TimelineReasoningItem }) {
  return <div>replacement:{item.content}</div>
}

describe('createTimelineRendererRegistry', () => {
  it('keeps renderer registrations isolated between React roots', () => {
    const firstRoot = createTimelineRendererRegistry()
    const secondRoot = createTimelineRendererRegistry()

    firstRoot.register('message', MessageRenderer)

    expect(firstRoot.resolve('message')).toBe(MessageRenderer)
    expect(secondRoot.resolve('message')).toBeUndefined()
  })

  it('rejects built-in overrides and duplicate registrations without replacing the original', () => {
    const registry = createTimelineRendererRegistry({
      builtInRenderers: { message: MessageRenderer },
    })

    expect(() => registry.register('message', ReplacementMessageRenderer)).toThrow(
      'Timeline renderer kind is locked: message',
    )
    expect(registry.resolve('message')).toBe(MessageRenderer)

    registry.register('reasoning', ReasoningRenderer)
    expect(() => registry.register('reasoning', ReplacementReasoningRenderer)).toThrow(
      'Timeline renderer already registered: reasoning',
    )
    expect(registry.resolve('reasoning')).toBe(ReasoningRenderer)
  })

  it('lets a disposer remove only the registration that created it', () => {
    const registry = createTimelineRendererRegistry()
    const disposeFirst = registry.register('reasoning', ReasoningRenderer)

    disposeFirst()
    const disposeSecond = registry.register('reasoning', ReplacementReasoningRenderer)
    disposeFirst()

    expect(registry.resolve('reasoning')).toBe(ReplacementReasoningRenderer)
    disposeSecond()
    expect(registry.resolve('reasoning')).toBeUndefined()
  })

})
