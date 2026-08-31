import { parseJpegStaticContainer } from './jpegStaticContainer'
import { parsePngStaticContainer } from './pngStaticContainer'
import { parseWebpStaticContainer } from './webpStaticContainer'

export interface StaticImageLimits {
  readonly maxWidth: number
  readonly maxHeight: number
}

export type StaticImagePolicyFailure = 'invalid' | 'animated' | 'dimensions'

export class StaticImagePolicyError extends Error {
  readonly code: StaticImagePolicyFailure

  constructor(code: StaticImagePolicyFailure) {
    super(`static image policy rejected: ${code}`)
    this.name = 'StaticImagePolicyError'
    this.code = code
  }
}

interface ImageMetadata {
  readonly width: number
  readonly height: number
  readonly animated: boolean
}

async function readBlob(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(new StaticImagePolicyError('invalid'))
    reader.readAsArrayBuffer(blob)
  })
}

function parseByMimeType(bytes: Uint8Array, mimeType: string): ImageMetadata {
  if (mimeType === 'image/png') return parsePngStaticContainer(bytes)
  if (mimeType === 'image/jpeg') return parseJpegStaticContainer(bytes)
  if (mimeType === 'image/webp') return parseWebpStaticContainer(bytes)
  throw new StaticImagePolicyError('invalid')
}

/** Dispatches container validation and applies a caller-provided static image budget. */
export async function inspectStaticImage(
  blob: Blob,
  mimeType: string,
  limits: StaticImageLimits,
): Promise<{ width: number; height: number }> {
  let metadata: ImageMetadata
  try {
    metadata = parseByMimeType(await readBlob(blob), mimeType)
  } catch (error) {
    if (error instanceof StaticImagePolicyError) throw error
    throw new StaticImagePolicyError('invalid')
  }
  if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
    || metadata.width <= 0 || metadata.height <= 0) {
    throw new StaticImagePolicyError('invalid')
  }
  if (metadata.animated) throw new StaticImagePolicyError('animated')
  if (!Number.isSafeInteger(limits.maxWidth) || !Number.isSafeInteger(limits.maxHeight)
    || limits.maxWidth <= 0 || limits.maxHeight <= 0
    || metadata.width > limits.maxWidth || metadata.height > limits.maxHeight) {
    throw new StaticImagePolicyError('dimensions')
  }
  return { width: metadata.width, height: metadata.height }
}
