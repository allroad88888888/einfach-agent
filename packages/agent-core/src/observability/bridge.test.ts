import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addEvent,
  bindActiveSpan,
  clearActiveSpan,
  configureObservability,
  endSpan,
  flushObservability,
  getActiveSpan,
  recordCompletedSpan,
  resetObservability,
  runTraceKey,
  startSpan,
  withSpan,
} from './trace'
import type { TraceDriver, TraceEvent, TraceSpan } from './types'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function captureDriver(): { driver: TraceDriver; spans: TraceSpan[]; events: TraceEvent[] } {
  const spans: TraceSpan[] = []
  const events: TraceEvent[] = []
  return {
    spans,
    events,
    driver: {
      async writeSpan(span) {
        spans.push(clone(span))
      },
      async writeEvent(event) {
        events.push(clone(event))
      },
    },
  }
}

afterEach(() => {
  resetObservability()
})

describe('observability/trace bridge', () => {
  it('未配置 driver 时是 no-op，不影响调用方', async () => {
    const span = startSpan('agent.turn', { kind: 'agent', attrs: { sessionId: 's1' } })
    addEvent('agent.done', { span })
    endSpan(span, 'ok')

    await expect(flushObservability()).resolves.toBeUndefined()
  })

  it('仅在 driver 存在时物化 attrs thunk', async () => {
    const noDriverAttrs = vi.fn(() => ({ requestPreview: 'large payload' }))
    const noDriverSpan = startSpan('llm.chat', { kind: 'llm', attrs: noDriverAttrs })
    addEvent('llm.delta', { span: noDriverSpan, attrs: noDriverAttrs })
    endSpan(noDriverSpan, 'ok', noDriverAttrs)
    recordCompletedSpan('performance.write', {
      startedAt: 1,
      endedAt: 2,
      attrs: noDriverAttrs,
    })

    expect(noDriverAttrs).not.toHaveBeenCalled()

    const captured = captureDriver()
    configureObservability({ driver: captured.driver })
    const observedAttrs = vi.fn(() => ({ requestPreview: 'large payload' }))
    const observedSpan = startSpan('llm.chat', { kind: 'llm', attrs: observedAttrs })
    addEvent('llm.delta', { span: observedSpan, attrs: observedAttrs })
    endSpan(observedSpan, 'ok', observedAttrs)
    recordCompletedSpan('performance.write', {
      startedAt: 1,
      endedAt: 2,
      attrs: observedAttrs,
    })

    await flushObservability()

    expect(observedAttrs).toHaveBeenCalledTimes(4)
    expect(captured.spans).toHaveLength(3)
    expect(captured.events).toHaveLength(1)
    expect(captured.spans[0]?.attrs?.requestPreview).toBe('large payload')
    expect(captured.events[0]?.attrs?.requestPreview).toBe('large payload')
    expect(captured.spans[1]?.attrs?.requestPreview).toBe('large payload')
    expect(captured.spans[2]?.attrs?.requestPreview).toBe('large payload')
  })

  it('写 span/event 时自动脱敏，并维护 active span', async () => {
    const captured = captureDriver()
    configureObservability({ driver: captured.driver })

    const span = startSpan('agent.turn', {
      kind: 'agent',
      attrs: { apiKey: 'secret', content_chars: 9, response: 'full answer' },
    })
    const key = runTraceKey('s1', 'r1')
    bindActiveSpan(key, span)
    addEvent('agent.resume.answers', { span, attrs: { token: 't', answers_count: 2 } })
    endSpan(span, 'ok', { status: 'done' })
    clearActiveSpan(key, span)

    await flushObservability()

    expect(getActiveSpan(key)).toBeUndefined()
    expect(captured.spans).toHaveLength(2)
    expect(captured.events).toHaveLength(1)
    expect(captured.spans[0]).toMatchObject({
      name: 'agent.turn',
      kind: 'agent',
      status: 'running',
      attrs: {
        apiKey: '[REDACTED]',
        content_chars: 9,
        response: { redacted: true, kind: 'string', chars: 11 },
      },
    })
    expect(captured.spans[1]).toMatchObject({ status: 'ok', attrs: { status: 'done' } })
    expect(captured.events[0].attrs).toMatchObject({ token: '[REDACTED]', answers_count: 2 })
  })

  it('driver 写入失败会被吞掉', async () => {
    configureObservability({
      driver: {
        writeSpan: vi.fn(async () => {
          throw new Error('disk down')
        }),
        writeEvent: vi.fn(async () => {
          throw new Error('disk down')
        }),
      },
    })

    const span = startSpan('llm.chat')
    addEvent('x', { span })
    endSpan(span, 'error', undefined, new Error('boom'))

    await expect(flushObservability()).resolves.toBeUndefined()
  })

  it('写入 tool attrs 时自动补出脱敏 preview', async () => {
    const captured = captureDriver()
    configureObservability({ driver: captured.driver })

    const args: Record<string, unknown> = { command: 'echo hello', token: 'secret-token' }
    args.self = args
    const span = startSpan('tool.call', {
      kind: 'tool',
      attrs: { sessionId: 's1', runId: 'r1', turnId: 'u1', toolName: 'shell', callId: 'c1', args },
    })
    endSpan(span, 'error', {
      result: { stdout: 'hello', apiKey: 'secret-key' },
      error: 'failed Bearer abcdefghijklmn',
    })

    await flushObservability()

    const ended = captured.spans.find((item) => item.name === 'tool.call' && item.status === 'error')
    expect(ended?.attrs?.args).toEqual({ redacted: true, kind: 'object', keys: 3 })
    expect(ended?.attrs?.result).toEqual({ redacted: true, kind: 'object', keys: 2 })
    expect(ended?.attrs?.argsPreview).toContain('"command":"echo hello"')
    expect(ended?.attrs?.argsPreview).toContain('[Circular]')
    expect(ended?.attrs?.argsPreview).not.toContain('secret-token')
    expect(ended?.attrs?.resultPreview).toContain('"stdout":"hello"')
    expect(ended?.attrs?.resultPreview).not.toContain('secret-key')
    expect(ended?.attrs?.errorPreview).toContain('Bearer [REDACTED]')
  })

  it('withSpan 按 async 结果结束 span', async () => {
    const captured = captureDriver()
    configureObservability({ driver: captured.driver })

    await expect(
      withSpan('tool.call', { kind: 'tool' }, async () => {
        throw new Error('boom Bearer abcdefghijklmn')
      }),
    ).rejects.toThrow('boom')
    await flushObservability()

    const ended = captured.spans.find((span) => span.name === 'tool.call' && span.status === 'error')
    expect(ended?.error).toContain('boom')
    expect(ended?.error).toContain('[REDACTED]')
    expect(ended?.error).not.toContain('abcdefghijklmn')
  })
})
