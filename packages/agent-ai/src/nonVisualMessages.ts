import type {
  ModelItem,
  UserContentBlock,
  UserImageContentBlock,
} from './modelProtocol'

function imagePlaceholder(block: UserImageContentBlock): string {
  return `[用户上传了图片 ${block.name}（${block.mimeType}），当前模型看不到图片内容]`
}

function blockText(block: UserContentBlock): string {
  return block.type === 'text' ? block.text : imagePlaceholder(block)
}

function structuredContentText(blocks: readonly UserContentBlock[]): string {
  let text = ''

  for (const block of blocks) {
    const next = blockText(block)
    if (text.length > 0) text += '\n'
    text += next
  }

  return text
}

/** Projects provider-neutral user blocks into the text-only wire shape. */
export function nonVisualMessages(messages: ModelItem[]): ModelItem[] {
  let changed = false
  const projected = messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message
    changed = true
    return {
      ...message,
      content: structuredContentText(message.content),
    }
  })

  return changed ? projected : messages
}
