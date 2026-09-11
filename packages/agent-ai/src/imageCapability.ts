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
  | {
      readonly kind: 'inline-base64'
      readonly accept: readonly string[]
      readonly limits: ImageInputLimits
    }

export const UNSUPPORTED_IMAGE_INPUT: ImageInputCapability = {
  kind: 'unsupported',
  reason: 'This model has no verified image input protocol.',
}

export const KIMI_K3_IMAGE_INPUT: ImageInputCapability = {
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

export const DEEPSEEK_VISION_IMAGE_INPUT: ImageInputCapability = {
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

export const OPENAI_COMPAT_BASE64_IMAGE_INPUT: Extract<
  ImageInputCapability,
  { kind: 'inline-base64' }
> = {
  kind: 'inline-base64',
  accept: ['image/jpeg', 'image/png', 'image/webp'],
  limits: {
    maxImages: 4,
    maxBytesPerImage: 5 * 1024 * 1024,
    // Base64 expands by roughly one third; keep one rollout record below its 16 MiB ceiling.
    maxBatchBytes: 10 * 1024 * 1024,
    maxWidth: 4096,
    maxHeight: 4096,
  },
}
