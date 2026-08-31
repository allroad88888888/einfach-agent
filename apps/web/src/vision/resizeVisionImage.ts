import type { WorkspaceImageReadResult } from '@einfach-agent/core'
import { DEEPSEEK_VISION_IMAGE_INPUT } from '@einfach-agent/ai'
import { inspectStaticImage } from '../imageInput/staticImagePolicy'

const LOW_DETAIL_BOUND = 512

interface DecodedVisionImage {
  readonly width: number
  readonly height: number
  close(): void
}

export interface ResizedVisionImage {
  data: Blob
  name: string
  mimeType: string
  width: number
  height: number
}

export interface VisionResizePlatform {
  decode(data: Blob): Promise<DecodedVisionImage>
  encode(
    image: CanvasImageSource,
    width: number,
    height: number,
    mimeType: string,
  ): Promise<Blob>
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const browserResizePlatform: VisionResizePlatform = {
  decode: (data) => globalThis.createImageBitmap(data),
  encode(image, width, height, mimeType) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return Promise.reject(new Error('canvas 2D context is unavailable'))
    context.drawImage(image, 0, 0, width, height)
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('canvas image encoding failed'))
      }, mimeType)
    })
  },
}

function scaledDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LOW_DETAIL_BOUND / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Applies the real low/high pixel policy before an image is uploaded. */
export async function resizeVisionImage(
  source: WorkspaceImageReadResult,
  detail: 'low' | 'high',
  signal?: AbortSignal,
  platform: VisionResizePlatform = browserResizePlatform,
): Promise<ResizedVisionImage> {
  signal?.throwIfAborted()
  const original = new Blob([decodeBase64(source.base64)], { type: source.mimeType })
  if (DEEPSEEK_VISION_IMAGE_INPUT.kind !== 'provider-upload') {
    throw new Error('vision image policy is unavailable')
  }
  const metadata = await inspectStaticImage(
    original,
    source.mimeType,
    DEEPSEEK_VISION_IMAGE_INPUT.limits,
  )
  signal?.throwIfAborted()
  if (detail === 'high') {
    return { data: original, name: source.filename, mimeType: source.mimeType, ...metadata }
  }

  const image = await platform.decode(original)
  try {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width <= 0 || image.height <= 0
      || image.width !== metadata.width || image.height !== metadata.height) {
      throw new Error('decoded image dimensions do not match container metadata')
    }
    const dimensions = scaledDimensions(image.width, image.height)
    if (dimensions.width === image.width && dimensions.height === image.height) {
      return {
        data: original,
        name: source.filename,
        mimeType: source.mimeType,
        ...dimensions,
      }
    }
    const data = await platform.encode(
      image as CanvasImageSource,
      dimensions.width,
      dimensions.height,
      source.mimeType,
    )
    signal?.throwIfAborted()
    if (data.type !== source.mimeType) {
      throw new Error('重编码图片格式与原图不一致')
    }
    return { data, name: source.filename, mimeType: source.mimeType, ...dimensions }
  } finally {
    image.close()
  }
}
