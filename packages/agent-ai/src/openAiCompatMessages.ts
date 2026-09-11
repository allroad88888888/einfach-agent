import type {
  ModelItem,
  UserContentBlock,
  UserItem,
} from './modelProtocol'

const INLINE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export interface OpenAiCompatTextContentBlock {
  type: 'text'
  text: string
}

export interface OpenAiCompatImageContentBlock {
  type: 'image_url'
  image_url: { url: string }
}

export type OpenAiCompatContentBlock =
  | OpenAiCompatTextContentBlock
  | OpenAiCompatImageContentBlock

export interface OpenAiCompatUserItem extends Omit<UserItem, 'content'> {
  content: string | readonly OpenAiCompatContentBlock[]
}

export type OpenAiCompatWireItem = Exclude<ModelItem, UserItem> | OpenAiCompatUserItem

function decodedByteSize(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

export function isValidInlineBase64Data(data: string, byteSize: number): boolean {
  return data.length > 0
    && data.length % 4 === 0
    && BASE64_PATTERN.test(data)
    && decodedByteSize(data) === byteSize
}

export function isValidInlineBase64ImageBlock(
  block: Extract<UserContentBlock, { type: 'image' }>,
): boolean {
  if (block.source.kind !== 'inline-base64') return false
  return INLINE_IMAGE_MIME_TYPES.has(block.mimeType)
    && isValidInlineBase64Data(block.source.data, block.byteSize)
}

function encodeBlock(block: UserContentBlock): OpenAiCompatContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.source.kind !== 'inline-base64') {
    throw new Error('OpenAI-compatible inline image input requires base64 image data.')
  }
  if (!isValidInlineBase64ImageBlock(block)) {
    throw new Error('OpenAI-compatible inline image data is invalid.')
  }
  const { data } = block.source
  return {
    type: 'image_url',
    image_url: { url: `data:${block.mimeType};base64,${data}` },
  }
}

/** Projects provider-neutral inline images to standard OpenAI-compatible image_url blocks. */
export function encodeOpenAiCompatMessages(
  messages: readonly ModelItem[],
): OpenAiCompatWireItem[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message
    if (typeof message.content === 'string') {
      return { role: 'user', content: message.content }
    }
    return {
      role: 'user',
      content: message.content.map(encodeBlock),
    }
  })
}
