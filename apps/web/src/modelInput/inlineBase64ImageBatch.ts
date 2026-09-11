import type { ImageInputCapability, UserImageContentBlock } from '@einfach-agent/ai'
import type { LocalImageInput } from './localImageInput'

type InlineBase64Capability = Extract<ImageInputCapability, { kind: 'inline-base64' }>

export interface InlineBase64ImageBatchOptions {
  readonly capability: InlineBase64Capability
  readonly signal: AbortSignal
}

function abortError(): Error {
  const error = new Error('图片准备已取消。')
  error.name = 'AbortError'
  return error
}

function readBase64(data: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal.removeEventListener('abort', cancel)
    const cancel = () => {
      reader.abort()
      cleanup()
      reject(abortError())
    }
    signal.addEventListener('abort', cancel, { once: true })
    reader.onerror = () => {
      cleanup()
      reject(new Error('无法读取图片。'))
    }
    reader.onload = () => {
      cleanup()
      const value = String(reader.result ?? '')
      const separator = value.indexOf(',')
      if (separator < 0 || !value.slice(0, separator).endsWith(';base64')) {
        reject(new Error('无法将图片转换为 base64。'))
        return
      }
      resolve(value.slice(separator + 1))
    }
    reader.readAsDataURL(data)
  })
}

async function prepareInlineImage(
  image: LocalImageInput,
  signal: AbortSignal,
): Promise<UserImageContentBlock> {
  if (signal.aborted) throw abortError()
  const data = await readBase64(image.data, signal)
  if (signal.aborted) throw abortError()
  return {
    type: 'image',
    source: { kind: 'inline-base64', data },
    name: image.name,
    mimeType: image.mimeType,
    byteSize: image.data.size,
    width: image.width,
    height: image.height,
  }
}

function validateImages(
  images: readonly LocalImageInput[],
  capability: InlineBase64Capability,
): void {
  const { accept, limits } = capability
  if (images.length > limits.maxImages) {
    throw new Error(`Inline image input accepts at most ${limits.maxImages} images per message.`)
  }
  let batchBytes = 0
  for (const image of images) {
    if (!accept.includes(image.mimeType)) {
      throw new Error(`Inline image input does not accept ${image.mimeType || '(empty)'}.`)
    }
    if (image.data.type && image.data.type !== image.mimeType) {
      throw new Error(`Inline image ${image.name} has inconsistent MIME metadata.`)
    }
    if (image.data.size === 0) throw new Error(`Inline image ${image.name} is empty.`)
    if (image.data.size > limits.maxBytesPerImage) {
      throw new Error(`Inline image ${image.name} exceeds the per-image byte limit.`)
    }
    if ((image.width ?? 0) > limits.maxWidth || (image.height ?? 0) > limits.maxHeight) {
      throw new Error(`Inline image ${image.name} exceeds the dimension limit.`)
    }
    batchBytes += image.data.size
  }
  if (batchBytes > limits.maxBatchBytes) {
    throw new Error('Inline image batch exceeds the total byte limit.')
  }
}

/** Converts validated local images into persisted provider-neutral base64 blocks. */
export async function prepareInlineBase64ImageBatch(
  images: readonly LocalImageInput[],
  options: InlineBase64ImageBatchOptions,
): Promise<readonly UserImageContentBlock[]> {
  validateImages(images, options.capability)
  return Promise.all(images.map((image) => prepareInlineImage(image, options.signal)))
}
