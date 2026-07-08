import { describe, expect, it } from 'vitest'
import { redactAttributes, redactAttributesWithPreviews, safePayloadPreview, truncatePayload } from './redact'

describe('observability/redact', () => {
  it('屏蔽敏感字段，保留普通 metadata', () => {
    const redacted = redactAttributes({
      apiKey: 'k',
      nested: { token: 't', password: 'p', vendor: 'deepseek' },
      content_chars: 42,
      result_kind: 'object',
    })

    expect(redacted).toMatchObject({
      apiKey: '[REDACTED]',
      nested: { token: '[REDACTED]', password: '[REDACTED]', vendor: 'deepseek' },
      content_chars: 42,
      result_kind: 'object',
    })
  })

  it('payload 类字段默认只保留形状，不落 prompt/response 正文', () => {
    const redacted = redactAttributes({
      messages: [{ role: 'user', content: 'secret prompt' }],
      response: 'secret answer',
      args: { query: 'secret args' },
      normal: 'ok',
    })

    expect(redacted?.messages).toEqual({ redacted: true, kind: 'array', items: 1 })
    expect(redacted?.response).toEqual({ redacted: true, kind: 'string', chars: 13 })
    expect(redacted?.args).toEqual({ redacted: true, kind: 'object', keys: 1 })
    expect(redacted?.normal).toBe('ok')
  })

  it('truncatePayload 先脱敏再截断', () => {
    const text = truncatePayload({ token: 'secret', note: 'a'.repeat(1000) }, 80)

    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain('secret')
    expect(text.length).toBeLessThanOrEqual(110)
    expect(text).toContain('<truncated')
  })

  it('显式 preview 字段允许大于普通字符串上限，但仍会脱敏', () => {
    const redacted = redactAttributes({
      requestPreview: `{"content":"${'p'.repeat(700)}","apiKey":"plain-secret"}`,
    })

    const preview = String(redacted?.requestPreview)
    expect(preview.length).toBeGreaterThan(650)
    expect(preview).toContain('p'.repeat(650))
    expect(preview).toContain('"apiKey":"[REDACTED]"')
    expect(preview).not.toContain('plain-secret')
    expect(preview).not.toContain('<truncated')
  })

  it('truncatePayload 支持为大 JSON preview 放宽单字段截断', () => {
    const text = truncatePayload(
      { messages: [{ role: 'user', content: 'prompt '.repeat(120) }] },
      2_000,
      { stringLimit: 1_000 },
    )

    expect(text).toContain('prompt '.repeat(80))
  })

  it('普通字符串里疑似密钥也会被屏蔽', () => {
    const redacted = redactAttributes({
      error: 'request failed: Bearer abcdefghijklmn apiKey=plain-secret sk-1234567890abcdef',
    })

    expect(redacted?.error).toContain('[REDACTED]')
    expect(redacted?.error).not.toContain('abcdefghijklmn')
    expect(redacted?.error).not.toContain('plain-secret')
    expect(redacted?.error).not.toContain('sk-1234567890abcdef')
  })

  it('safePayloadPreview 处理循环引用、BigInt 和敏感字段', () => {
    const payload: Record<string, unknown> = {
      command: 'echo hello',
      token: 'secret-token',
      count: 1n,
    }
    payload.self = payload

    const text = safePayloadPreview(payload, 220)

    expect(text).toContain('"command":"echo hello"')
    expect(text).toContain('"token":"[REDACTED]"')
    expect(text).toContain('"count":"1n"')
    expect(text).toContain('[Circular]')
    expect(text).not.toContain('secret-token')
    expect(text.length).toBeLessThanOrEqual(250)
  })

  it('safePayloadPreview 处理 getter 抛错这类不可 JSON 的对象', () => {
    const payload = new Proxy(
      {},
      {
        ownKeys() {
          return ['ok', 'bad']
        },
        getOwnPropertyDescriptor(_target, key) {
          if (key === 'ok') return { configurable: true, enumerable: true, value: true }
          throw new Error('token=plain-secret')
        },
      },
    )

    const text = safePayloadPreview(payload)

    expect(text).toContain('"ok":true')
    expect(text).toContain('[Unreadable:')
    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain('plain-secret')
  })

  it('redactAttributesWithPreviews 为 tool payload 补安全预览，同时原 payload 仍只留形状', () => {
    const redacted = redactAttributesWithPreviews({
      args: { command: 'cat package.json', password: 'p' },
      result: { stdout: 'done', apiKey: 'secret-key' },
      error: 'failed with Bearer abcdefghijklmn',
    })

    expect(redacted?.args).toEqual({ redacted: true, kind: 'object', keys: 2 })
    expect(redacted?.result).toEqual({ redacted: true, kind: 'object', keys: 2 })
    expect(redacted?.argsPreview).toContain('cat package.json')
    expect(redacted?.argsPreview).not.toContain('"password":"p"')
    expect(redacted?.resultPreview).toContain('"stdout":"done"')
    expect(redacted?.resultPreview).not.toContain('secret-key')
    expect(redacted?.errorPreview).toContain('Bearer [REDACTED]')
  })
})
