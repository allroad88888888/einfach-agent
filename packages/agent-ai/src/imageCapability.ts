export interface ImageInputLimits {
  readonly maxImages: number
  readonly maxBytesPerImage: number
  readonly maxBatchBytes: number
  readonly maxWidth: number
  readonly maxHeight: number
}

export type ImageInputCapability =
  | { readonly kind: 'unsupported'; readonly reason: string }
  | {
      readonly kind: 'provider-upload'
      readonly accept: readonly string[]
      readonly limits: ImageInputLimits
    }

export const UNSUPPORTED_IMAGE_INPUT: ImageInputCapability = {
  kind: 'unsupported',
  reason: 'This model has no verified image input protocol.',
}

export const KIMI_K2_6_IMAGE_INPUT: ImageInputCapability = {
  kind: 'provider-upload',
  accept: ['image/jpeg', 'image/png', 'image/webp'],
  limits: {
    maxImages: 8,
    maxBytesPerImage: 20 * 1024 * 1024,
    maxBatchBytes: 40 * 1024 * 1024,
    maxWidth: 4096,
    maxHeight: 2160,
  },
}
