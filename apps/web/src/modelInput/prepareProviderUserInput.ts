import {
  prepareKimiImageBatch,
  resolveKimiRegion,
  type KimiLocalImage,
  type UserContentBlock,
} from '@web-agent/ai'
import type { UserInputPreparer } from '@web-agent/core'
import { imageInputCapabilityForApp } from './kimiImageFeature'
import { kimiRegionSetting } from './kimiRegionSetting'

function kimiImages(
  images: NonNullable<Parameters<UserInputPreparer>[0]['images']>,
): KimiLocalImage[] {
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
  if (context.settings.vendor !== 'kimi') {
    throw new Error(`模型供应商 ${context.settings.vendor} 尚未配置图片准备 adapter。`)
  }
  const region = resolveKimiRegion(kimiRegionSetting(context.settings))
  if (region !== 'cn') throw new Error('当前宿主尚未开放 Kimi 全球区图片传输。')
  const batch = await prepareKimiImageBatch(kimiImages(input.images), {
    apiKey: context.apiKey,
    region,
    signal: context.signal,
    fetchImpl: context.fetchImpl,
  })
  const content: UserContentBlock[] = [
    ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
    ...batch.blocks,
  ]
  return { content, rollback: () => batch.rollback() }
}
