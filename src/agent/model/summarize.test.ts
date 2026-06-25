import { describe, expect, it, vi } from 'vitest'
import { DeepSeekModelAdapter } from './deepseek-adapter'
import { MockModelAdapter } from './mock-adapter'
import { DEFAULT_DEEPSEEK_MODEL } from './index'
import type { SummarizeInput } from './types'

const createSseResponse = (chunks: unknown[]) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

const makeDeepSeek = (fetchImpl: ReturnType<typeof vi.fn>) =>
  new DeepSeekModelAdapter(
    {
      provider: 'deepseek',
      apiKey: 'test-key',
      model: DEFAULT_DEEPSEEK_MODEL,
      baseUrl: 'https://api.deepseek.com',
    },
    fetchImpl as unknown as typeof fetch,
  )

const sampleInput: SummarizeInput = {
  previousSummary: '用户偏好：简洁。',
  messages: [
    { role: 'user', content: '第一轮提问' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '第二轮提问' },
    { role: 'assistant', content: '第二轮回答' },
  ],
}

describe('M2.1/M2.3 DeepSeek summarize', () => {
  it('calls chat/completions with a structured Chinese prompt and the previous summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createSseResponse([{ choices: [{ delta: { content: '新摘要内容' } }] }]),
    )
    const adapter = makeDeepSeek(fetchImpl)

    const result = await adapter.summarize(sampleInput)
    expect(result).toEqual({ source: 'deepseek', summary: '新摘要内容' })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    // structured blocks enforced (M2.3)
    expect(body.messages[0].content).toContain('用户偏好')
    expect(body.messages[0].content).toContain('已确认决策')
    expect(body.messages[0].content).toContain('关键事实')
    expect(body.messages[0].content).toContain('未决事项')
    // incremental: previous summary + the compression window are both present
    expect(body.messages.at(-1).content).toContain('用户偏好：简洁。')
    expect(body.messages.at(-1).content).toContain('第一轮提问')
    expect(body.messages.at(-1).content).toContain('第二轮回答')
  })

  it('throws (degradation signal) when DeepSeek returns an error or empty answer', async () => {
    const errorFetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(makeDeepSeek(errorFetch).summarize(sampleInput)).rejects.toThrow()

    const emptyFetch = vi.fn().mockResolvedValue(createSseResponse([]))
    await expect(makeDeepSeek(emptyFetch).summarize(sampleInput)).rejects.toThrow()
  })

  it('rethrows AbortError', async () => {
    const abortFetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(makeDeepSeek(abortFetch).summarize(sampleInput)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('M2.1 Mock summarize (deterministic + controllable)', () => {
  it('produces a deterministic summary including the previous summary and turn count', async () => {
    const adapter = new MockModelAdapter()
    const result = await adapter.summarize(sampleInput)

    expect(result.source).toBe('mock')
    expect(result.summary).toContain('用户偏好：简洁。')
    // deterministic — same input → same output
    const again = await adapter.summarize(sampleInput)
    expect(again.summary).toBe(result.summary)
  })

  it('can be configured to fail (for degradation / CAS tests)', async () => {
    const adapter = new MockModelAdapter()
    adapter.summarizeShouldFail = true
    await expect(adapter.summarize(sampleInput)).rejects.toThrow()
  })

  it('can be configured to delay (for race / single-flight tests)', async () => {
    const adapter = new MockModelAdapter()
    let resolved = false
    adapter.summarizeDelay = () => new Promise<void>((r) => setTimeout(r, 40))
    const p = adapter.summarize(sampleInput).then((res) => {
      resolved = true
      return res
    })
    expect(resolved).toBe(false)
    const res = await p
    expect(resolved).toBe(true)
    expect(res.source).toBe('mock')
  })
})
