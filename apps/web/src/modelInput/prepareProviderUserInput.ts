import type { UserContentBlock } from '@einfach-agent/ai'
import type { UserInputPreparer } from '@einfach-agent/core'
import { prepareInlineBase64ImageBatch } from './inlineBase64ImageBatch'
import type { LocalImageInput } from './localImageInput'
import { imageInputCapabilityForApp } from './modelImageInputCapability'
import { prepareProviderImageBatch } from './providerImageBatch'

function providerImages(
  images: NonNullable<Parameters<UserInputPreparer>[0]['images']>,
): LocalImageInput[] {
  return images.map((image) => {
    if (!(image.data instanceof Blob)) {
      throw new Error(`图片“${image.name}”没有可上传的本地数据。`)
    }
    if (image.data.size !== image.byteSize || (image.data.type && image.data.type !== image.mimeType)) {
      throw new Error(`图片“${image.name}”的文件元数据不一致。`)
    }
    return {
      data: image.data,
      name: image.name,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
    }
  })
}

/** Host composition only: provider-specific preparation remains inside the selected adapter. */
export const prepareProviderUserInput: UserInputPreparer = async (input, context) => {
  if (!input.images?.length) return { content: input.text }
  const capability = imageInputCapabilityForApp(context.settings)
  if (capability.kind === 'unsupported') throw new Error(capability.reason)
  const images = providerImages(input.images)
  if (capability.kind === 'inline-base64') {
    const blocks = await prepareInlineBase64ImageBatch(images, {
      capability,
      signal: context.signal,
    })
    const content: UserContentBlock[] = [
      ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
      ...blocks,
    ]
    return { content }
  }
  const batch = await prepareProviderImageBatch(images, {
    settings: context.settings,
    apiKey: context.apiKey,
    signal: context.signal,
    fetchImpl: context.fetchImpl,
  })
  const content: UserContentBlock[] = [
    ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
    ...batch.blocks,
  ]
  return { content, rollback: () => batch.rollback() }
}
