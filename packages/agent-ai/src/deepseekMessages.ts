import type {
  ModelItem,
  UserContentBlock,
  UserItem,
} from './modelProtocol'
import { isValidDeepSeekFileId } from './providerTransport'
import { imageInputCapability } from './vendorDescriptor'

export const DEEPSEEK_FILE_SCOPE = 'deepseek:default'

export interface DeepSeekTextContentBlock {
  type: 'text'
  text: string
}

export interface DeepSeekFileContentBlock {
  type: 'file'
  file_id: string
}

export type DeepSeekContentBlock = DeepSeekTextContentBlock | DeepSeekFileContentBlock
export interface DeepSeekUserItem extends Omit<UserItem, 'content'> {
  content: string | readonly DeepSeekContentBlock[]
}
export type DeepSeekWireItem = Exclude<ModelItem, UserItem> | DeepSeekUserItem

export function isDeepSeekFileReference(reference: string): boolean {
  return isValidDeepSeekFileId(reference)
}

function encodeDeepSeekBlock(block: UserContentBlock, model: string): DeepSeekContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (imageInputCapability('deepseek', model).kind !== 'provider-upload') {
    throw new Error(`DeepSeek model ${model} has no verified image input protocol.`)
  }
  const { source } = block
  if (source.kind !== 'provider-file') {
    throw new Error('DeepSeek image source must be a provider file reference.')
  }
  if (source.provider !== 'deepseek') {
    throw new Error(`DeepSeek cannot consume an image reference from ${source.provider}.`)
  }
  if (source.scope !== DEEPSEEK_FILE_SCOPE) {
    throw new Error(`DeepSeek image scope ${source.scope} does not match the official API scope.`)
  }
  if (!isDeepSeekFileReference(source.reference)) {
    throw new Error('DeepSeek image reference must use a valid file-api-* id.')
  }
  return { type: 'file', file_id: source.reference }
}

/** Projects provider-neutral history to DeepSeek's file-aware Chat wire messages. */
export function encodeDeepSeekMessages(
  messages: readonly ModelItem[],
  model: string,
): DeepSeekWireItem[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message
    if (typeof message.content === 'string') {
      return { role: 'user', content: message.content }
    }
    return {
      role: 'user',
      content: message.content.map((block) => encodeDeepSeekBlock(block, model)),
    }
  })
}
