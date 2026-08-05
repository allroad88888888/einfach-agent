import type {
  ModelItem,
  UserContentBlock,
  UserItem,
} from './modelProtocol'
import { kimiReferenceScope, type KimiRegion } from './kimiRegion'
import { imageInputCapability } from './vendorDescriptor'

export interface KimiTextContentBlock {
  type: 'text'
  text: string
}

export interface KimiImageUrlContentBlock {
  type: 'image_url'
  image_url: { url: string }
}

export type KimiContentBlock = KimiTextContentBlock | KimiImageUrlContentBlock
export interface KimiUserItem extends Omit<UserItem, 'content'> {
  content: string | KimiContentBlock[]
}
export type KimiWireItem = Exclude<ModelItem, UserItem> | KimiUserItem

export function isKimiFileReference(reference: string): boolean {
  return /^ms:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(reference)
}

function encodeKimiBlock(
  block: UserContentBlock,
  region: KimiRegion,
  model: string,
): KimiContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (imageInputCapability('kimi', model).kind !== 'provider-upload') {
    throw new Error(`Kimi model ${model} has no verified image input protocol.`)
  }
  if (block.source.kind !== 'provider-file') {
    throw new Error('Kimi image source must be a provider file reference.')
  }
  if (block.source.provider !== 'kimi') {
    throw new Error(`Kimi cannot consume an image reference from ${block.source.provider}.`)
  }
  const expectedScope = kimiReferenceScope(region)
  if (block.source.scope !== expectedScope) {
    throw new Error(
      `Kimi image scope ${block.source.scope} does not match request scope ${expectedScope}.`,
    )
  }
  if (!isKimiFileReference(block.source.reference)) {
    throw new Error('Kimi image reference must use a valid ms:// file URI.')
  }
  return {
    type: 'image_url',
    image_url: { url: block.source.reference },
  }
}

/** Projects provider-neutral history to Kimi's OpenAI-compatible wire messages. */
export function encodeKimiMessages(
  messages: readonly ModelItem[],
  region: KimiRegion,
  model: string,
): KimiWireItem[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message
    if (typeof message.content === 'string') {
      return { role: 'user', content: message.content }
    }
    return {
      role: 'user',
      content: message.content.map((block) => encodeKimiBlock(block, region, model)),
    }
  })
}
