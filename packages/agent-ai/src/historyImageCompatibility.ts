import { DEFAULT_KIMI_MODEL, kimiReferenceScope } from './kimiRegion'
import type { UserImageContentBlock } from './modelProtocol'

export interface HistoryImageTarget {
  vendor: string
  model: string
  region?: string
}

export type HistoryImageUnavailableReason =
  | 'target_provider_unsupported'
  | 'target_model_unsupported'
  | 'source_provider_mismatch'
  | 'source_region_mismatch'
  | 'source_reference_invalid'

export interface HistoryImageDisplayMetadata {
  name: string
  mimeType: string
  byteSize: number
  width?: number
  height?: number
}

export type HistoryImageProjection =
  | { kind: 'consumable'; image: UserImageContentBlock }
  | {
      kind: 'placeholder'
      reason: HistoryImageUnavailableReason
      metadata: HistoryImageDisplayMetadata
    }

const KIMI_FILE_REFERENCE = /^ms:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

function placeholder(
  image: UserImageContentBlock,
  reason: HistoryImageUnavailableReason,
): HistoryImageProjection {
  const { name, mimeType, byteSize, width, height } = image
  return { kind: 'placeholder', reason, metadata: { name, mimeType, byteSize, width, height } }
}

/** Projects persisted provider references against the exact active adapter contract. */
export function projectHistoryImage(
  image: UserImageContentBlock,
  target: HistoryImageTarget,
): HistoryImageProjection {
  if (target.vendor !== 'kimi') return placeholder(image, 'target_provider_unsupported')
  if (target.model !== DEFAULT_KIMI_MODEL) return placeholder(image, 'target_model_unsupported')
  if (image.source.provider !== 'kimi') return placeholder(image, 'source_provider_mismatch')
  if (target.region && target.region !== 'cn' && target.region !== 'global') {
    return placeholder(image, 'source_region_mismatch')
  }
  const region = target.region === 'global' ? 'global' : 'cn'
  if (image.source.scope !== kimiReferenceScope(region)) {
    return placeholder(image, 'source_region_mismatch')
  }
  if (!KIMI_FILE_REFERENCE.test(image.source.reference)) {
    return placeholder(image, 'source_reference_invalid')
  }
  return { kind: 'consumable', image }
}
