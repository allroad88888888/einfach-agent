import type {
  ModelChatResponse,
  ToolItem,
  UserContentBlock,
  UserMessageContent,
} from './modelProtocol'

function containsImage(blocks: readonly UserContentBlock[]): boolean {
  return blocks.some((block) => block.type === 'image')
}

/** Extracts tool-authored text while keeping inline image bytes opaque. */
export function toolMessageText(item: ToolItem): string {
  const images = item.model_content?.filter((block) => block.type === 'image') ?? []
  return [item.content, ...images.map((block) => `[图片：${block.name}（${block.mimeType}）]`)]
    .filter(Boolean)
    .join('\n')
}

/** Returns trace-safe tool output summary without provider references or inline bytes. */
export function toolMessageTracePreview(item: ToolItem): UserMessageTracePreview {
  return {
    text: item.content,
    imageCount: item.model_content?.filter((block) => block.type === 'image').length ?? 0,
  }
}

/** Extracts only user-authored text without exposing provider image references. */
export function userMessageText(content: UserMessageContent): string {
  if (typeof content === 'string') return content
  return content
    .flatMap((block) => block.type === 'text' ? [block.text] : [])
    .join('')
}

/** Produces a human label for text and image-only turns. */
export function userMessageLabel(
  content: UserMessageContent,
  imageOnlyLabel = '图片对话',
): string {
  const text = userMessageText(content).trim()
  if (text || typeof content === 'string') return text
  return containsImage(content) ? imageOnlyLabel : ''
}

export interface UserMessageTracePreview {
  text: string
  imageCount: number
}

function imageSourceVersion(block: Extract<UserContentBlock, { type: 'image' }>): readonly string[] {
  return block.source.kind === 'provider-file'
    ? [block.source.kind, block.source.provider, block.source.scope, block.source.reference]
    : [block.source.kind, block.source.data]
}

/** Returns trace-safe summary data without scope, reference, or provider identifiers. */
export function userMessageTracePreview(content: UserMessageContent): UserMessageTracePreview {
  return {
    text: userMessageText(content),
    imageCount: typeof content === 'string'
      ? 0
      : content.filter((block) => block.type === 'image').length,
  }
}

/** Produces a stable content identity that includes ordered opaque image references. */
export function userMessageVersion(content: UserMessageContent): string {
  if (typeof content === 'string') return JSON.stringify(['text', content])
  return JSON.stringify(content.map((block) => block.type === 'text'
    ? ['text', block.text]
    : [
        'image',
        ...imageSourceVersion(block),
        block.name,
        block.mimeType,
        block.byteSize,
        block.width ?? null,
        block.height ?? null,
      ]))
}

/** Extracts the first assistant text choice from a chat response, if any. */
export function firstAssistantText(response: ModelChatResponse): string {
  const content = response.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}
