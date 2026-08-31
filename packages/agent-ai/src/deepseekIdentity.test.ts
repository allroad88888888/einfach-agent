import { describe, expect, it } from 'vitest'
import {
  MAX_DEEPSEEK_USER_ID_LENGTH,
  callDeepSeek,
  normalizeDeepSeekUserId,
} from './deepseek'

const BASE_URL = 'https://deepseek.example/v1'

function okResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('DeepSeek user identity', () => {
  it('只接受 DeepSeek user_id 协议允许的字符和长度', () => {
    expect(normalizeDeepSeekUserId('wa_abc-XYZ_0123')).toBe('wa_abc-XYZ_0123')
    expect(normalizeDeepSeekUserId('')).toBeUndefined()
    expect(normalizeDeepSeekUserId('person@example.com')).toBeUndefined()
    expect(normalizeDeepSeekUserId('/Users/person/project')).toBeUndefined()
    expect(normalizeDeepSeekUserId('a'.repeat(MAX_DEEPSEEK_USER_ID_LENGTH + 1)))
      .toBeUndefined()
    expect(normalizeDeepSeekUserId(42)).toBeUndefined()
  })

  it('不会隐式生成 user_id，并在协议边界丢弃非法值', async () => {
    const captured: Record<string, unknown>[] = []
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return okResponse()
    }

    await callDeepSeek(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '无 user id' }] },
      { apiKey: 'test-key', baseUrl: BASE_URL, fetchImpl, retry: { maxRetries: 0 } },
    )
    await callDeepSeek(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '非法 user id' }],
        user_id: 'person@example.com',
      },
      { apiKey: 'test-key', baseUrl: BASE_URL, fetchImpl, retry: { maxRetries: 0 } },
    )

    expect(captured).toHaveLength(2)
    expect(captured[0]).not.toHaveProperty('user_id')
    expect(captured[1]).not.toHaveProperty('user_id')
  })
})
