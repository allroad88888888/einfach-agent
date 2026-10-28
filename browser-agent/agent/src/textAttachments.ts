import type { UserContentBlock, UserMessageContent } from '@einfach-agent/ai'
import type { UserInputPreparer } from '@einfach-agent/core'

export interface TextAttachment {
  id: string
  name: string
  mimeType: string
  byteSize: number
  data: Blob | { fileId: string }
}

const textAccept = '.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.xml,.yaml,.yml,.html,.css,.js,.ts,.sql'
export const TEXT_ATTACHMENT_ACCEPT = `${textAccept},.pdf,.png,.jpg,.jpeg,.webp,.gif`
const extensions = new Set(textAccept.split(',').map((entry) => entry.slice(1)))
const ocrTypes: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export function isOcrAttachment(name: string): boolean { return Object.hasOwn(ocrTypes, name.split('.').pop()?.toLowerCase() ?? '') }
const MAX_FILES = 6
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 512 * 1024
const MAX_TEXT_CHARACTERS = 100_000

export function validateTextAttachments(files: readonly Pick<TextAttachment, 'name' | 'byteSize'>[]): void {
  if (files.length > MAX_FILES) throw new Error('一次最多添加 6 个附件。')
  for (const file of files) {
    if (!extensions.has(file.name.split('.').pop()?.toLowerCase() ?? '') && !isOcrAttachment(file.name)) {
      throw new Error(`“${file.name}”暂不支持。请选择文本、PDF 或图片；Word 请先导出为 PDF。`)
    }
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize <= 0) throw new Error(`“${file.name}”是空文件。`)
    const maxBytes = isOcrAttachment(file.name) ? 20 * 1024 * 1024 : MAX_FILE_BYTES
    if (file.byteSize > maxBytes) throw new Error(`“${file.name}”超过 ${isOcrAttachment(file.name) ? '20 MB' : '256 KB'}，请拆分后添加。`)
  }
  if (files.filter((file) => !isOcrAttachment(file.name)).reduce((total, file) => total + file.byteSize, 0) > MAX_TOTAL_BYTES) throw new Error('文本附件总大小不能超过 512 KB。')
  if (files.reduce((total, file) => total + file.byteSize, 0) > 40 * 1024 * 1024) throw new Error('附件总大小不能超过 40 MB。')
}

/** Selection only retains local blobs; nothing leaves the browser until send. */
export function addTextAttachments(current: readonly TextAttachment[], files: readonly File[]): TextAttachment[] {
  const next = [...current, ...files.map((file) => ({ id: crypto.randomUUID(), name: file.name, mimeType: ocrTypes[file.name.split('.').pop()?.toLowerCase() ?? ''] || file.type || 'text/plain', byteSize: file.size, data: file }))]
  validateTextAttachments(next)
  return next
}

function readBytes(blob: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => reader.abort()
    const done = () => signal.removeEventListener('abort', abort)
    reader.onload = () => { done(); resolve(reader.result as ArrayBuffer) }
    reader.onerror = () => { done(); reject(reader.error ?? new Error('文件读取失败。')) }
    reader.onabort = () => { done(); reject(new DOMException('读取已取消', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    reader.readAsArrayBuffer(blob)
  })
}

function decodeText(bytes: ArrayBuffer, name: string): string {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2))
  const encoding = head[0] === 255 && head[1] === 254 ? 'utf-16le' : head[0] === 254 && head[1] === 255 ? 'utf-16be' : 'utf-8'
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new Error(`“${name}”无法按文本读取，请另存为 UTF-8 后重试。`) }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error(`“${name}”含有二进制数据，无法作为文本附件发送。`)
  if (!text.trim()) throw new Error(`“${name}”没有可读取的文本。`)
  return text
}

/** Uses core's transactional preparation: rejected or aborted submissions retain the draft. */
export const prepareTextAttachments: UserInputPreparer = async (input, context) => {
  if (input.images?.length) throw new Error('当前插件尚未接入图片附件，请选择文本文件。')
  if (!input.files?.length) return { content: input.text }
  validateTextAttachments(input.files)
  const content: UserContentBlock[] = input.text ? [{ type: 'text', text: input.text }] : []
  let characters = input.text.length
  for (const file of input.files) {
    if (isOcrAttachment(file.name)) throw new Error('PDF/图片须通过会话附件准备器读取。')
    if (!(file.data instanceof Blob) || file.data.size !== file.byteSize) throw new Error(`“${file.name}”的文件数据已失效，请重新选择。`)
    const bytes = await readBytes(file.data, context.signal)
    context.signal.throwIfAborted()
    const text = decodeText(bytes, file.name)
    characters += text.length
    if (characters > MAX_TEXT_CHARACTERS) throw new Error('消息与附件合计超过 10 万字符，请拆分后发送。')
    content.push({ type: 'text', text, attachment: { name: file.name, mimeType: file.mimeType, byteSize: file.byteSize } })
  }
  return { content }
}

/** Restores local, sendable attachments from persisted extracted content on undo. */
export function restoreTextAttachmentDraft(content: UserMessageContent): { text: string; files: TextAttachment[] } {
  if (typeof content === 'string') return { text: content, files: [] }
  const files: TextAttachment[] = []
  const text: string[] = []
  for (const block of content) {
    if (block.type !== 'text') continue
    if (!block.attachment) { text.push(block.text); continue }
    if (block.attachment.fileId) {
      files.push({ id: crypto.randomUUID(), name: block.attachment.name, mimeType: block.attachment.mimeType, byteSize: block.attachment.byteSize, data: { fileId: block.attachment.fileId } })
      continue
    }
    let data = new Blob([block.text], { type: block.attachment.mimeType })
    // A valid UTF-16 file can grow beyond the per-file limit when re-encoded as UTF-8.
    if (data.size > MAX_FILE_BYTES) {
      const bytes = new ArrayBuffer((block.text.length + 1) * 2)
      const view = new DataView(bytes)
      view.setUint16(0, 0xfeff, true)
      for (let index = 0; index < block.text.length; index++) view.setUint16((index + 1) * 2, block.text.charCodeAt(index), true)
      data = new Blob([bytes], { type: block.attachment.mimeType })
    }
    files.push({ id: crypto.randomUUID(), name: block.attachment.name, mimeType: block.attachment.mimeType, byteSize: data.size, data })
  }
  return { text: text.join(''), files }
}
