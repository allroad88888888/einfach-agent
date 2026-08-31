import {
  DEEPSEEK_VISION_MODEL,
  DEFAULT_KIMI_MODEL,
  prepareDeepSeekImageBatch,
  prepareKimiImageBatch,
  resolveKimiRegion,
  type UserImageContentBlock,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'
import { kimiRegionSetting } from './kimiRegionSetting'

export interface ProviderLocalImage {
  data: Blob
  name: string
  mimeType: string
  width?: number
  height?: number
}

export interface ProviderImageBatchOptions {
  settings: Readonly<ModelSettings>
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

export interface PreparedProviderImageBatch {
  readonly blocks: readonly UserImageContentBlock[]
  rollback(): Promise<void>
}

type ProviderImagePreparer = (
  images: readonly ProviderLocalImage[],
  options: ProviderImageBatchOptions,
) => Promise<PreparedProviderImageBatch>

function kimiImageBatch(
  images: readonly ProviderLocalImage[],
  options: ProviderImageBatchOptions,
): Promise<PreparedProviderImageBatch> {
  const region = resolveKimiRegion(kimiRegionSetting(options.settings))
  if (region !== 'cn') throw new Error('当前宿主尚未开放 Kimi 全球区图片传输。')
  return prepareKimiImageBatch(images, {
    apiKey: options.apiKey,
    region,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
}

function deepSeekImageBatch(
  images: readonly ProviderLocalImage[],
  options: ProviderImageBatchOptions,
): Promise<PreparedProviderImageBatch> {
  return prepareDeepSeekImageBatch(images, {
    apiKey: options.apiKey,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
}

const PROVIDER_IMAGE_PREPARERS: Readonly<Record<string, ProviderImagePreparer>> = {
  [`kimi:${DEFAULT_KIMI_MODEL}`]: kimiImageBatch,
  [`deepseek:${DEEPSEEK_VISION_MODEL}`]: deepSeekImageBatch,
}

/** Dispatches Composer image batches to the exact provider-model upload contract. */
export function prepareProviderImageBatch(
  images: readonly ProviderLocalImage[],
  options: ProviderImageBatchOptions,
): Promise<PreparedProviderImageBatch> {
  const { vendor, model } = options.settings
  const prepare = PROVIDER_IMAGE_PREPARERS[`${vendor}:${model}`]
  if (prepare === undefined) {
    throw new Error(`模型 ${vendor}/${model} 尚未配置图片准备 adapter。`)
  }
  return prepare(images, options)
}
