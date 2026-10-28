import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createPaddleOcrTool } from './tool'
import { PADDLE_OCR_JOB_URL, runPaddleOcr, type OcrHost, type OcrContext } from './client'
import { parseOcrResult } from './result'

const token = 'ocr-test-secret'
const resultUrl = 'https://storage.example/result.jsonl?signature=test'
const page = (text: string) => ({ prunedResult: { rec_texts: [text], rec_scores: [0.98] }, ocrImage: 'https://storage.example/page.jpg' })
const jsonl = `${JSON.stringify({ result: { ocrResults: [page('合同编号：A-123'), page('租金：5000 元')] } })}\n\n${JSON.stringify({ result: { ocrResults: [page('第三页')] } })}\n`
const done = () => Response.json({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } })
const context = (controller = new AbortController()): OcrContext => ({ sessionId: 'session-one', signal: controller.signal, progress: vi.fn() })
const asToolContext = (ctx: OcrContext) => ctx as ToolContext
afterEach(() => vi.useRealTimers())

describe('PaddleOCR job protocol', () => {
  it('submits a URL once, polls progress, and reads every JSONL batch without sending credentials to storage', async () => {
    let polls = 0
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') return Response.json({ data: { jobId: 'job-1' } })
      if (String(input) === resultUrl) return new Response(jsonl)
      return ++polls === 1 ? Response.json({ data: { state: 'running', extractProgress: { extractedPages: 1, totalPages: 3 } } }) : done()
    })
    const ctx = context()
    const result = await runPaddleOcr({ fileUrl: 'https://files.example/document.pdf', useDocUnwarping: true, pageRanges: '1-3' }, ctx, { getToken: () => token, fetch: fetchImpl, pollIntervalMs: 0 })
    expect(result).toMatchObject({ jobId: 'job-1', pageCount: 3, truncated: false, pages: [{ page: 1, text: '合同编号：A-123', confidence: 0.98 }, { page: 2, text: '租金：5000 元' }, { page: 3, text: '第三页' }] })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ fileUrl: 'https://files.example/document.pdf', model: 'PP-OCRv6', pageRanges: '1-3', optionalPayload: { useDocOrientationClassify: false, useDocUnwarping: true, useTextlineOrientation: false } })
    expect(ctx.progress).toHaveBeenCalledWith('OCR 识别中 1/3 页 · job-1')
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization')).toBe(`bearer ${token}`)
    expect(fetchImpl.mock.calls.at(-1)).toEqual([resultUrl, expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })])
    expect(new Headers(fetchImpl.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBeNull()
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('uploads a session attachment as multipart without forcing a boundary or sending a file URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => init?.method === 'POST' ? Response.json({ data: { jobId: 'local-1' } }) : String(input) === resultUrl ? new Response(jsonl) : done())
    const resolveAttachment = vi.fn(async () => ({ name: '合同.pdf', data: new Blob(['%PDF-demo'], { type: 'application/pdf' }) }))
    await runPaddleOcr({ attachmentId: 'file-1' }, context(), { getToken: () => token, fetch: fetchImpl, resolveAttachment })
    expect(resolveAttachment).toHaveBeenCalledWith('file-1', expect.objectContaining({ sessionId: 'session-one' }))
    const init = fetchImpl.mock.calls[0][1]!
    const form = init.body as FormData
    expect(form.get('model')).toBe('PP-OCRv6')
    expect((form.get('file') as File).name).toBe('合同.pdf')
    expect(form.has('fileUrl')).toBe(false)
    expect(new Headers(init.headers).has('content-type')).toBe(false)
  })

  it('returns a resumable job ID on timeout and a later query never resubmits', async () => {
    vi.useFakeTimers()
    let ready = false
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => init?.method === 'POST' ? Response.json({ data: { jobId: 'slow-job' } }) : String(input) === resultUrl ? new Response(jsonl) : ready ? done() : Response.json({ data: { state: 'pending' } }))
    const host: OcrHost = { getToken: () => token, fetch: fetchImpl }
    const tool = createPaddleOcrTool(host)
    const running = tool.execute({ fileUrl: 'https://example.test/a.pdf', timeoutMs: 1000 }, asToolContext(context()))
    await vi.advanceTimersByTimeAsync(1001)
    expect(await running).toMatchObject({ ok: false, code: 'OCR_TIMEOUT', details: { jobId: 'slow-job' }, retryable: false })
    ready = true
    expect(await tool.execute({ jobId: 'slow-job' }, asToolContext(context()))).toMatchObject({ ok: true, data: { jobId: 'slow-job', pageCount: 3 } })
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(tool.replayUnsafe).toBe(true)
  })

  it('stops polling on cancellation and keeps the known job ID', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(async () => { controller.abort(); return Response.json({ data: { state: 'running' } }) })
    const result = await createPaddleOcrTool({ getToken: () => token, fetch: fetchImpl }).execute({ jobId: 'existing' }, asToolContext(context(controller)))
    expect(result).toMatchObject({ ok: false, code: 'OCR_CANCELLED', details: { jobId: 'existing' } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ data: { state: 'failed', errorMsg: `bad input ${token}` } }, 'OCR_JOB_FAILED'],
    [{ data: { state: 'mystery' } }, 'OCR_RESPONSE_INVALID'],
    [{ data: { state: 'done', resultUrl: { jsonUrl: 'file:///secret' } } }, 'OCR_RESPONSE_INVALID'],
  ])('fails closed for service errors without leaking the token', async (payload, code) => {
    const tool = createPaddleOcrTool({ getToken: () => token, fetch: async () => Response.json(payload) })
    const result = await tool.execute({ jobId: 'existing' }, asToolContext(context()))
    expect(result).toMatchObject({ ok: false, code, details: { jobId: 'existing' } })
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('does not retry rejected uploads or echo a raw provider response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`invalid credential ${token}`, { status: 401 }))
    expect(await createPaddleOcrTool({ getToken: () => token, fetch: fetchImpl }).execute({ fileUrl: 'https://example.test/a.pdf' }, asToolContext(context()))).toMatchObject({ ok: false, code: 'OCR_HTTP_ERROR', error: 'PaddleOCR 请求失败（HTTP 401）。' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry a submission whose response was lost', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(`network request ${token}`) })
    const result = await createPaddleOcrTool({ getToken: () => token, fetch: fetchImpl }).execute({ fileUrl: 'https://example.test/a.pdf' }, asToolContext(context()))
    expect(result).toMatchObject({ ok: false, code: 'OCR_SUBMISSION_UNKNOWN', retryable: false })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('honors a signal that was already cancelled without making a request', async () => {
    const controller = new AbortController(); controller.abort()
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await createPaddleOcrTool({ getToken: () => token, fetch: fetchImpl }).execute({ jobId: 'existing' }, asToolContext(context(controller)))
    expect(result).toMatchObject({ ok: false, code: 'OCR_CANCELLED', details: { jobId: 'existing' } })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects missing credentials, multiple sources and invalid URLs before network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const host = { getToken: () => token, fetch: fetchImpl }
    for (const input of [{}, { fileUrl: 'file:///tmp/a.pdf' }, { fileUrl: 'https://u:p@example.test/a.pdf' }, { jobId: 'a', attachmentId: 'b' }]) {
      await expect(runPaddleOcr(input, context(), host)).rejects.toHaveProperty('code', 'OCR_INPUT_INVALID')
    }
    await expect(runPaddleOcr({ jobId: 'a' }, context(), { ...host, getToken: () => undefined })).rejects.toHaveProperty('code', 'OCR_NOT_CONFIGURED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('marks truncated text and rejects malformed JSONL instead of treating it as no text', () => {
    expect(parseOcrResult('a', jsonl, 4)).toMatchObject({ pageCount: 3, truncated: true, pages: [{ page: 1, text: '合同编号' }] })
    expect(() => parseOcrResult('a', '{oops', 100)).toThrow('JSONL')
    expect(() => parseOcrResult('a', JSON.stringify({ result: { ocrResults: [{}] } }), 100)).toThrow('识别文字')
  })
})
