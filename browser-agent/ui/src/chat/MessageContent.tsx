import type { ConversationItem } from '@einfach-agent/core'

type Content = Extract<ConversationItem['item'], { role: 'user' }>['content'] | null

export function MessageContent({ content }: { content: Content }) {
  if (typeof content === 'string') return content ? <p>{content}</p> : null
  return <>{content?.map((block, index) => {
    if (block.type === 'image') return <span className="bav-sent-file" key={index}>{block.name}</span>
    if (!block.attachment) return <p key={index}>{block.text}</p>
    return <details className="bav-sent-file" key={index}><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6" /></svg><span title={block.attachment.name}>{block.attachment.name}</span><small>{Math.max(1, Math.ceil(block.attachment.byteSize / 1024))} KB</small></summary>{block.attachment.fileId ? <p className="bav-field-help">已保存到当前会话，可用 paddle_ocr 识别。</p> : <pre>{block.text}</pre>}</details>
  })}</>
}
