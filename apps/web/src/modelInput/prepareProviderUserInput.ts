import type { UserContentBlock } from '@einfach-agent/ai'
import type { UserInputPreparer } from '@einfach-agent/core'
import { imageInputCapabilityForApp } from './kimiImageFeature'
import { prepareProviderImageBatch, type ProviderLocalImage } from './providerImageBatch'

function providerImages(
  images: NonNullable<Parameters<UserInputPreparer>[0]['images']>,
): ProviderLocalImage[] {
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
  const capability = imageInputCapabilityForApp(context.settings.vendor, context.settings.model)
  if (capability.kind !== 'provider-upload') throw new Error(capability.reason)
  const batch = await prepareProviderImageBatch(providerImages(input.images), {
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
