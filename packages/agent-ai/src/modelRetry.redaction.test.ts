import { describe, expect, it, vi } from 'vitest'
import {
  requestOnce,
  resolveRetryConfig,
  RetriableError,
  withRetry,
} from './modelRetry'

const SECRET_BODY = JSON.stringify({
  authorization: 'Bearer sk-upstream-secret',
  api_key: 'sk-api-key-like-secret',
  image: 'ms://private-file-reference',
  prompt: 'verbatim private user body',
})

function secretResponse(status: number, requestId?: string): Response {
  return new Response(SECRET_BODY, {
    status,
    headers: requestId === undefined ? undefined : { 'X-Request-Id': requestId },
  })
}

function expectSecretsRedacted(message: string): void {
  expect(message).not.toContain('Bearer')
  expect(message).not.toContain('sk-upstream-secret')
  expect(message).not.toContain('sk-api-key-like-secret')
  expect(message).not.toContain('ms://')
  expect(message).not.toContain('verbatim private user body')
  expect(message.length).toBeLessThanOrEqual(240)
}

describe('HTTP upstream error redaction', () => {
  it('keeps status, category, and a strictly validated request id for 4xx', async () => {
    let thrown: unknown
    try {
      await requestOnce(async () => secretResponse(401, 'req_safe-123.abc'), 'unused', {})
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('Chat completion returned 401')
    expect(message).toContain('authentication_error')
    expect(message).toContain('request_id=req_safe-123.abc')
    expectSecretsRedacted(message)
  })

  it('keeps retry classification and exposes only a safe retry reason', async () => {
    let calls = 0
    const reasons: string[] = []
    const config = resolveRetryConfig({
      maxRetries: 1,
      baseDelayMs: 0,
      jitter: false,
      sleepImpl: async () => undefined,
      onRetry: ({ reason }) => reasons.push(reason),
    })

    const result = await withRetry(config, undefined, async () => {
      calls += 1
      if (calls === 1) {
        return requestOnce(async () => secretResponse(503, 'upstream_req_456'), 'unused', {})
      }
      return new Response('ok')
    })

    expect(await result.text()).toBe('ok')
    expect(calls).toBe(2)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('Chat completion returned 503')
    expect(reasons[0]).toContain('upstream_error')
    expect(reasons[0]).toContain('request_id=upstream_req_456')
    expectSecretsRedacted(reasons[0])
  })

  it('omits an untrusted request id instead of attempting to redact it', async () => {
    const pending = requestOnce(
      async () => secretResponse(503, 'sk-api-key-like-secret'),
      'unused',
      {},
    )

    let thrown: unknown
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RetriableError)
    expect((thrown as Error).message).not.toContain('request_id=')
    expectSecretsRedacted((thrown as Error).message)
  })

  it('retains only validated structured provider diagnostics', async () => {
    const response = new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_parameter',
        param: 'tool_choice',
        message: 'Bearer sk-upstream-secret must never be exposed',
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    let thrown: unknown
    try {
      await requestOnce(async () => response, 'unused', {})
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('provider_type=invalid_request_error')
    expect(message).toContain('provider_code=invalid_parameter')
    expect(message).toContain('param=tool_choice')
    expectSecretsRedacted(message)
  })

  it('replaces thrown transport details in retry observers and final errors', async () => {
    const secret = 'Bearer sk-network-secret ms://private-network-reference'
    const observed: unknown[] = []
    const config = resolveRetryConfig({
      maxRetries: 1,
      baseDelayMs: 0,
      jitter: false,
      sleepImpl: async () => undefined,
      onRetry: ({ error }) => observed.push(error),
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError(secret) })

    let thrown: unknown
    try {
      await withRetry(config, undefined, () => requestOnce(fetchImpl, 'unused', {}))
    } catch (error) {
      thrown = error
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(observed).toHaveLength(1)
    expect(String(observed[0])).not.toContain(secret)
    expect(String(thrown)).not.toContain(secret)
    expect(String(thrown)).toContain('network_error')
  })
})
