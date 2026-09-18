import type {
  ModelItem,
  ToolOutputContentBlock,
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

function toolBlockText(block: ToolOutputContentBlock): string {
  return block.type === 'text'
    ? block.text
    : `[工具返回了图片 ${block.name}（${block.mimeType}），当前模型看不到图片内容]`
}

/** Projects image-bearing tool outputs for chat providers that only accept tool-result text. */
export function nonVisualToolMessages(messages: readonly ModelItem[]): ModelItem[] {
  let changed = false
  const projected = messages.map((message) => {
    if (message.role !== 'tool' || message.model_content === undefined) return message
    changed = true
    const imageNote = message.model_content
      .filter((block) => block.type === 'image')
      .map(toolBlockText)
      .join('\n')
    const { model_content: _modelContent, ...textMessage } = message
    return {
      ...textMessage,
      content: [message.content, imageNote].filter(Boolean).join('\n'),
    }
  })
  return changed ? projected : messages as ModelItem[]
}

/** Projects provider-neutral user blocks into the text-only wire shape. */
export function nonVisualMessages(messages: ModelItem[]): ModelItem[] {
  const toolProjected = nonVisualToolMessages(messages)
  let changed = toolProjected !== messages
  const projected = toolProjected.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message
    changed = true
    return {
      ...message,
      content: structuredContentText(message.content),
    }
  })

  return changed ? projected : messages
}
