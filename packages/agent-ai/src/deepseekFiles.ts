import { DEEPSEEK_BASE_URL } from './deepseek'
import { DEEPSEEK_VISION_IMAGE_INPUT } from './imageCapability'
import type { ChatCallOptions } from './modelApi'
import type { UserImageContentBlock } from './modelProtocol'
import { isAbortError } from './modelRetry'
import { DEEPSEEK_FILE_SCOPE, isDeepSeekFileReference } from './deepseekMessages'

type ProviderFetch = NonNullable<ChatCallOptions['fetchImpl']>

export interface DeepSeekLocalImage {
  data: Blob
  name: string
  mimeType: string
  width?: number
  height?: number
}

export interface DeepSeekImagePreparationOptions {
  apiKey: string
  signal?: AbortSignal
  fetchImpl?: ProviderFetch
}

export interface PreparedDeepSeekImageBatch {
  readonly blocks: readonly UserImageContentBlock[]
  /** Best-effort, idempotent deletion of every uploaded provider file in this batch. */
  rollback(): Promise<void>
}

interface UploadedDeepSeekImage {
  fileId: string
  block: UserImageContentBlock
}

function validateImages(images: readonly DeepSeekLocalImage[]): void {
  if (DEEPSEEK_VISION_IMAGE_INPUT.kind !== 'provider-upload') {
    throw new Error('DeepSeek image upload capability is unavailable.')
  }
  const { accept, limits } = DEEPSEEK_VISION_IMAGE_INPUT
  if (images.length > limits.maxImages) {
    throw new Error(`DeepSeek accepts at most ${limits.maxImages} images per message.`)
  }
  let batchBytes = 0
  for (const image of images) {
    if (!accept.includes(image.mimeType)) {
      throw new Error(`DeepSeek does not accept image type ${image.mimeType || '(empty)'}.`)
    }
    if (image.data.type && image.data.type !== image.mimeType) {
      throw new Error(`DeepSeek image ${image.name} has inconsistent MIME metadata.`)
    }
    if (image.data.size === 0) throw new Error(`DeepSeek image ${image.name} is empty.`)
    if (image.data.size > limits.maxBytesPerImage) {
      throw new Error(`DeepSeek image ${image.name} exceeds the per-image byte limit.`)
    }
    if ((image.width ?? 0) > limits.maxWidth || (image.height ?? 0) > limits.maxHeight) {
      throw new Error(`DeepSeek image ${image.name} exceeds the dimension limit.`)
    }
    batchBytes += image.data.size
  }
  if (batchBytes > limits.maxBatchBytes) {
    throw new Error('DeepSeek image batch exceeds the total byte limit.')
  }
}

function filesUrl(path = ''): string {
  return `${DEEPSEEK_BASE_URL.replace(/\/+$/, '')}/files${path}`
}

function authorization(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` }
}

async function uploadImage(
  image: DeepSeekLocalImage,
  options: DeepSeekImagePreparationOptions,
): Promise<UploadedDeepSeekImage> {
  options.signal?.throwIfAborted()
  const form = new FormData()
  form.append('file', image.data, image.name)
  form.append('purpose', 'user_data')
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(filesUrl(), {
      method: 'POST',
      headers: authorization(options.apiKey),
      body: form,
      signal: options.signal,
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new Error('DeepSeek image upload transport failed.')
  }
  if (!response.ok) {
    throw new Error(`DeepSeek image upload failed with HTTP ${response.status}.`)
  }
  let payload: { id?: unknown }
  try {
    payload = await response.json() as { id?: unknown }
  } catch {
    throw new Error('DeepSeek image upload returned invalid JSON.')
  }
  if (typeof payload.id !== 'string' || !isDeepSeekFileReference(payload.id)) {
    throw new Error('DeepSeek image upload returned an invalid file id.')
  }
  return {
    fileId: payload.id,
    block: {
      type: 'image',
      source: {
        kind: 'provider-file',
        provider: 'deepseek',
        scope: DEEPSEEK_FILE_SCOPE,
        reference: payload.id,
      },
      name: image.name,
      mimeType: image.mimeType,
      byteSize: image.data.size,
      width: image.width,
      height: image.height,
    },
  }
}

async function cleanupUploads(
  uploads: readonly UploadedDeepSeekImage[],
  options: DeepSeekImagePreparationOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  await Promise.allSettled(uploads.map(({ fileId }) => Promise.resolve().then(() => fetchImpl(
    filesUrl(`/${encodeURIComponent(fileId)}`),
    { method: 'DELETE', headers: authorization(options.apiKey) },
  ))))
}

/** Uploads a complete image batch and retains rollback for transaction rejection. */
export async function prepareDeepSeekImageBatch(
  images: readonly DeepSeekLocalImage[],
  options: DeepSeekImagePreparationOptions,
): Promise<PreparedDeepSeekImageBatch> {
  validateImages(images)
  options.signal?.throwIfAborted()
  const results = await Promise.allSettled(images.map((image) => uploadImage(image, options)))
  const uploads = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure || options.signal?.aborted) {
    await cleanupUploads(uploads, options)
    options.signal?.throwIfAborted()
    throw failure?.reason
  }
  let rolledBack = false
  return {
    blocks: uploads.map(({ block }) => block),
    async rollback() {
      if (rolledBack) return
      rolledBack = true
      await cleanupUploads(uploads, options)
    },
  }
}
