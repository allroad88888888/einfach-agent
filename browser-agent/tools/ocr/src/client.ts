import { parseOcrResult, publicUrl, record, type OcrResult } from './result'

export const PADDLE_OCR_JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'
export const PADDLE_OCR_MODEL = 'PP-OCRv6'
export interface OcrOptions { useDocOrientationClassify?: boolean; useDocUnwarping?: boolean; useTextlineOrientation?: boolean }
export interface OcrInput extends OcrOptions { fileUrl?: string; attachmentId?: string; jobId?: string; timeoutMs?: number; maxChars?: number; pageRanges?: string }
export interface OcrContext { sessionId: string; signal: AbortSignal; progress(text: string): void }
export interface OcrHost {
  getToken(): string | undefined
  resolveAttachment?(id: string, ctx: OcrContext): Promise<{ name: string; data: Blob }>
  fetch?: typeof fetch
  /** Host-controlled polling interval, useful for embedded deployments and tests. */
  pollIntervalMs?: number
}
export class OcrError extends Error {
  constructor(message: string, readonly code: string, readonly jobId?: string) { super(message); this.name = 'OcrError' }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('OCR 响应过大，请指定较小的 pageRanges。') }
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally { reader.releaseLock() }
}

function validate(input: OcrInput): void {
  if ([input.fileUrl, input.attachmentId, input.jobId].filter((value) => value !== undefined).length !== 1) throw new OcrError('fileUrl、attachmentId、jobId 必须且只能填写一项。', 'OCR_INPUT_INVALID')
  if (input.fileUrl !== undefined && !publicUrl(input.fileUrl)) throw new OcrError('fileUrl 必须是无内嵌凭据的 HTTP(S) 地址。', 'OCR_INPUT_INVALID')
  for (const id of [input.attachmentId, input.jobId]) if (id !== undefined && (typeof id !== 'string' || !/^[\w.-]{1,200}$/.test(id))) throw new OcrError('文件或任务 ID 格式无效。', 'OCR_INPUT_INVALID')
  for (const key of ['useDocOrientationClassify', 'useDocUnwarping', 'useTextlineOrientation'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new OcrError('OCR 开关必须为布尔值。', 'OCR_INPUT_INVALID')
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120000)) throw new OcrError('timeoutMs 应在 1000–120000 范围内。', 'OCR_INPUT_INVALID')
  if (input.maxChars !== undefined && (!Number.isInteger(input.maxChars) || input.maxChars < 1 || input.maxChars > 50000)) throw new OcrError('maxChars 应在 1–50000 范围内。', 'OCR_INPUT_INVALID')
  if (input.pageRanges !== undefined && (typeof input.pageRanges !== 'string' || input.pageRanges.length > 200 || !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(input.pageRanges))) throw new OcrError('pageRanges 格式示例：1-3,5。', 'OCR_INPUT_INVALID')
}

export async function runPaddleOcr(input: OcrInput, ctx: OcrContext, host: OcrHost): Promise<OcrResult> {
  validate(input)
  const token = host.getToken()?.trim()
  if (!token) throw new OcrError('请在设置 → 工具服务中配置 PaddleOCR Token。', 'OCR_NOT_CONFIGURED')
  const controller = new AbortController()
  const abort = () => controller.abort(ctx.signal.reason)
  if (ctx.signal.aborted) throw new OcrError('OCR 查询已停止。', 'OCR_CANCELLED', input.jobId)
  ctx.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('OCR timeout', 'TimeoutError')), input.timeoutMs ?? 60000)
  const signal = controller.signal
  const fetchImpl = host.fetch ?? globalThis.fetch
  let jobId = input.jobId
  let submissionStarted = false
  async function api(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `bearer ${token}` }, signal, credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw new OcrError(`PaddleOCR 请求失败（HTTP ${response.status}）。`, 'OCR_HTTP_ERROR', jobId)
    const payload = record(JSON.parse(await boundedText(response, 512 * 1024)))
    const data = record(payload.data)
    if (!Object.keys(data).length) throw new OcrError('PaddleOCR 响应缺少 data。', 'OCR_RESPONSE_INVALID', jobId)
    return data
  }
  try {
    if (!jobId) {
      const optionalPayload = { useDocOrientationClassify: input.useDocOrientationClassify ?? false, useDocUnwarping: input.useDocUnwarping ?? false, useTextlineOrientation: input.useTextlineOrientation ?? false }
      let init: RequestInit
      if (input.attachmentId) {
        if (!host.resolveAttachment) throw new OcrError('当前宿主未提供会话附件读取能力。', 'OCR_ATTACHMENT_UNAVAILABLE')
        let file: { name: string; data: Blob }
        try { file = await host.resolveAttachment(input.attachmentId, { ...ctx, signal }) }
        catch { throw new OcrError('当前会话找不到该附件，请重新选择文件。', 'OCR_ATTACHMENT_UNAVAILABLE') }
        signal.throwIfAborted()
        if (!file.data.size || file.data.size > 20 * 1024 * 1024) throw new OcrError('OCR 附件须为非空文件且不超过 20 MB。', 'OCR_INPUT_INVALID')
        const body = new FormData()
        body.append('file', file.data, file.name)
        body.append('model', PADDLE_OCR_MODEL)
        body.append('optionalPayload', JSON.stringify(optionalPayload))
        if (input.pageRanges) body.append('pageRanges', input.pageRanges)
        init = { method: 'POST', body }
      } else {
        init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: PADDLE_OCR_MODEL, fileUrl: input.fileUrl, optionalPayload, ...(input.pageRanges ? { pageRanges: input.pageRanges } : {}) }) }
      }
      ctx.progress('正在提交 OCR 任务…')
      submissionStarted = true
      const submitted = await api(PADDLE_OCR_JOB_URL, init)
      if (typeof submitted.jobId !== 'string' || !/^[\w.-]{1,200}$/.test(submitted.jobId)) throw new OcrError('PaddleOCR 未返回有效 jobId，不能安全自动重试提交。', 'OCR_SUBMISSION_UNKNOWN')
      jobId = submitted.jobId
    }
    while (true) {
      signal.throwIfAborted()
      const data = await api(`${PADDLE_OCR_JOB_URL}/${encodeURIComponent(jobId)}`)
      if (data.state === 'failed') {
        const message = typeof data.errorMsg === 'string' ? data.errorMsg.replaceAll(token, '[redacted]').slice(0, 300) : '请检查文件格式或服务状态。'
        throw new OcrError(`PaddleOCR 任务失败：${message}`, 'OCR_JOB_FAILED', jobId)
      }
      if (data.state === 'done') {
        const url = publicUrl(record(data.resultUrl).jsonUrl)
        if (!url || !url.startsWith('https:')) throw new OcrError('OCR 结果地址无效。', 'OCR_RESPONSE_INVALID', jobId)
        // Signed storage URLs never receive the service token, cookies, or referrer.
        const response = await fetchImpl(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
        if (!response.ok) throw new OcrError(`OCR 结果下载失败（HTTP ${response.status}）。`, 'OCR_RESULT_FAILED', jobId)
        const jsonl = await boundedText(response, 16 * 1024 * 1024)
        try { return parseOcrResult(jobId, jsonl, input.maxChars ?? 30000) }
        catch { throw new OcrError('OCR 结果格式无效或缺少识别文字。', 'OCR_RESULT_INVALID', jobId) }
      }
      if (data.state !== 'pending' && data.state !== 'running') throw new OcrError('PaddleOCR 返回未知任务状态。', 'OCR_RESPONSE_INVALID', jobId)
      const progress = record(data.extractProgress)
      const pages = typeof progress.extractedPages === 'number' && typeof progress.totalPages === 'number' ? ` ${progress.extractedPages}/${progress.totalPages} 页` : ''
      ctx.progress(`OCR ${data.state === 'pending' ? '排队中' : '识别中'}${pages} · ${jobId}`)
      await delay(host.pollIntervalMs ?? 5000, signal)
    }
  } catch (error) {
    if (submissionStarted && !jobId && !(error instanceof OcrError && error.code === 'OCR_HTTP_ERROR')) throw new OcrError('提交响应未确认，云端任务可能已经创建。请检查服务任务记录，勿自动重新上传。', 'OCR_SUBMISSION_UNKNOWN')
    if (signal.aborted) throw new OcrError(ctx.signal.aborted ? 'OCR 查询已停止；已提交的云端任务可能仍在运行。' : 'OCR 等待超时。请使用 jobId 继续查询，不要重新上传。', ctx.signal.aborted ? 'OCR_CANCELLED' : 'OCR_TIMEOUT', jobId)
    if (error instanceof OcrError) throw error
    // Arbitrary transport/provider messages may contain headers or signed URLs.
    throw new OcrError('OCR 请求或结果解析失败。', 'OCR_REQUEST_FAILED', jobId)
  } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort) }
}
