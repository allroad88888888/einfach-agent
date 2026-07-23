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

// SENSITIVE_KEY 是子串匹配，含 "token" 的 key 全被抹掉，于是 token 用量指标在 trace 里
// 只剩一排 [REDACTED]——想查「这轮烧了多少 / 上下文多大 / 压缩生效没」时正好是瞎的。
// 放行判据是「key 以 tokens 结尾」【且】「值是有限数字」，两条必须同时成立。
// 下面两组用例分别钉住放行侧与脱敏侧；脱敏侧更重要——放宽错了就是 API key 落盘。
describe('observability/redact · token 用量指标豁免', () => {
  it('数字型 token 计数指标原样保留（否则观测性在用量维度上是瞎的）', () => {
    const out = redactAttributes({
      max_tokens: 8000,
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
      estimated_tokens: 4096,
      estimated_context_tokens: 51_200,
      usage: { prompt_tokens: 11, completion_tokens: 22 },
    })

    expect(out?.max_tokens).toBe(8000)
    expect(out?.prompt_tokens).toBe(1234)
    expect(out?.completion_tokens).toBe(567)
    expect(out?.total_tokens).toBe(1801)
    expect(out?.estimated_tokens).toBe(4096)
    expect(out?.estimated_context_tokens).toBe(51_200)
    // 嵌套对象里的同名 key 同样放行（redactValue 递归路径）。
    expect(out?.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 22 })
  })

  it('真实密钥一个都不许漏（放宽判据时这条最先红）', () => {
    const out = redactAttributes({
      token: 'sk-live-aaaaaaaa',
      access_token: 'sk-live-bbbbbbbb',
      refresh_token: 'sk-live-cccccccc',
      auth_token: 'sk-live-dddddddd',
      api_key: 'sk-live-eeeeeeee',
      apiKey: 'sk-live-ffffffff',
      'api-key': 'sk-live-gggggggg',
      authorization: 'Bearer xyz',
      Authorization: 'Bearer XYZ',
      bearer: 'xyz',
      secret: 's3cr3t',
      password: 'hunter2',
      passwd: 'hunter2',
    })

    for (const key of Object.keys(out ?? {})) {
      expect({ key, value: out?.[key] }).toEqual({ key, value: '[REDACTED]' })
    }
  })

  it('key 叫 tokens 但值不是数字 → 仍然脱敏（这是防密钥落盘的保险，不是可选项）', () => {
    const out = redactAttributes({
      tokens: ['sk-live-aaaa', 'sk-live-bbbb'], // 一组密钥，不是计数
      access_tokens: 'sk-live-cccc',
      cached_tokens: { nested: 'sk-live-dddd' },
      nan_tokens: Number.NaN, // 非有限数字不算指标
      inf_tokens: Number.POSITIVE_INFINITY,
    })

    expect(out?.tokens).toBe('[REDACTED]')
    expect(out?.access_tokens).toBe('[REDACTED]')
    expect(out?.cached_tokens).toBe('[REDACTED]')
    expect(out?.nan_tokens).toBe('[REDACTED]')
    expect(out?.inf_tokens).toBe('[REDACTED]')
  })

  it('preview 路径与 redactValue 路径判据一致（两处只要有一处放宽错，密钥就会落盘）', () => {
    const out = redactAttributesWithPreviews({
      resultPreview: {
        total_tokens: 999,
        access_token: 'sk-live-zzzz',
        tokens: 'sk-live-yyyy',
      },
    })
    const text = JSON.stringify(out?.resultPreview)

    expect(text).toContain('999')
    expect(text).not.toContain('sk-live-zzzz')
    expect(text).not.toContain('sk-live-yyyy')
  })
})
