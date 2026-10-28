import type { UserInputPreparer } from '@einfach-agent/core'
import type { UserContentBlock } from '@einfach-agent/ai'
import type { AttachmentStore } from './attachmentStore'
import { prepareTextAttachments, validateTextAttachments, isOcrAttachment } from './textAttachments'

/** Keeps model-visible file references small; binary bytes live in the host's session store. */
export function createAttachmentPreparer(store: AttachmentStore, assertDocumentAccess?: (sessionId: string) => void): UserInputPreparer {
  return async (input, context) => {
    validateTextAttachments(input.files ?? [])
    const textFiles = input.files?.filter((file) => !isOcrAttachment(file.name))
    const prepared = await prepareTextAttachments({ ...input, files: textFiles }, context)
    const documents = input.files?.filter((file) => isOcrAttachment(file.name)) ?? []
    if (!documents.length) return prepared
    assertDocumentAccess?.(context.sessionId)
    const content: UserContentBlock[] = typeof prepared.content === 'string' ? prepared.content ? [{ type: 'text', text: prepared.content }] : [] : [...prepared.content]
    const created: string[] = []
    const rollback = async () => { await Promise.all(created.map((id) => store.remove(context.sessionId, id))) }
    try {
      for (const file of documents) {
        context.signal.throwIfAborted()
        let fileId: string
        if (file.data instanceof Blob) {
          if (file.data.size !== file.byteSize) throw new Error('附件大小不匹配，请重新选择。')
          fileId = `file-${crypto.randomUUID()}`
          await store.put({ id: fileId, sessionId: context.sessionId, name: file.name, mimeType: file.mimeType, byteSize: file.byteSize, data: file.data })
          created.push(fileId)
        } else {
          const reference = file.data as { fileId?: unknown } | null
          if (!reference || typeof reference.fileId !== 'string') throw new Error('附件数据失效，请重新选择。')
          const saved = await store.get(context.sessionId, reference.fileId)
          if (saved.name !== file.name || saved.byteSize !== file.byteSize) throw new Error('附件引用与文件不匹配。')
          fileId = saved.id
        }
        content.push({ type: 'text', text: `此文件尚未识别。请使用 paddle_ocr 工具读取，attachmentId=${fileId}。`, attachment: { name: file.name, mimeType: file.mimeType, byteSize: file.byteSize, fileId } })
      }
      context.signal.throwIfAborted()
      return { content, rollback }
    } catch (error) { await rollback(); throw error }
  }
}
