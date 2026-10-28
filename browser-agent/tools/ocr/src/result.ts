export interface OcrPage { page: number; text: string; confidence?: number; ocrImage?: string }
export interface OcrResult { jobId: string; state: 'done'; pages: OcrPage[]; pageCount: number; truncated: boolean }

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined }
  catch { return undefined }
}

/** JSONL rows contain batches, not necessarily one page per line. Preserve their order. */
export function parseOcrResult(jobId: string, jsonl: string, maxChars: number): OcrResult {
  const pages: OcrPage[] = []
  let remaining = maxChars
  let pageCount = 0
  let truncated = false
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: unknown
    try { row = JSON.parse(line) } catch { throw new Error('OCR 结果不是有效的 JSONL。') }
    const results = record(record(row).result).ocrResults
    if (!Array.isArray(results)) throw new Error('OCR 结果缺少 ocrResults。')
    for (const item of results) {
      pageCount++
      const raw = record(item)
      const result = record(raw.prunedResult)
      if (!Array.isArray(result.rec_texts) || !result.rec_texts.every((text) => typeof text === 'string')) throw new Error('OCR 页面缺少识别文字。')
      const text = result.rec_texts.join('\n')
      if (remaining <= 0 || pages.length >= 200) { truncated = true; continue }
      const scores = Array.isArray(result.rec_scores) ? result.rec_scores.filter((score): score is number => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) : []
      const image = publicUrl(raw.ocrImage)
      pages.push({ page: pageCount, text: text.slice(0, remaining), ...(scores.length ? { confidence: scores.reduce((a, b) => a + b, 0) / scores.length } : {}), ...(image ? { ocrImage: image } : {}) })
      truncated ||= text.length > remaining
      remaining -= text.length
    }
  }
  if (!pageCount) throw new Error('OCR 结果没有页面。')
  return { jobId, state: 'done', pages, pageCount, truncated }
}
