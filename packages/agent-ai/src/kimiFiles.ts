import { KIMI_K3_IMAGE_INPUT } from './imageCapability'
import type { UserImageContentBlock } from './modelProtocol'
import { isAbortError } from './modelRetry'
import {
  kimiBaseUrl,
  kimiReferenceScope,
  type KimiRegion,
} from './kimiRegion'

export interface KimiLocalImage {
  data: Blob
  name: string
  mimeType: string
  width?: number
  height?: number
}

export interface KimiImagePreparationOptions {
  apiKey: string
  region: KimiRegion
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface PreparedKimiImageBatch {
  readonly blocks: readonly UserImageContentBlock[]
  /** Best-effort, idempotent deletion of every uploaded provider file in this batch. */
  rollback(): Promise<void>
}

interface UploadedKimiImage {
  fileId: string
  block: UserImageContentBlock
}

function validateImages(images: readonly KimiLocalImage[]): void {
  if (KIMI_K3_IMAGE_INPUT.kind !== 'provider-upload') {
    throw new Error('Kimi image upload capability is unavailable.')
  }
  const { accept, limits } = KIMI_K3_IMAGE_INPUT
  if (images.length > limits.maxImages) {
    throw new Error(`Kimi accepts at most ${limits.maxImages} images per message.`)
  }
  let batchBytes = 0
  for (const image of images) {
    if (!accept.includes(image.mimeType)) {
      throw new Error(`Kimi does not accept image type ${image.mimeType || '(empty)'}.`)
    }
    if (image.data.type && image.data.type !== image.mimeType) {
      throw new Error(`Kimi image ${image.name} has inconsistent MIME metadata.`)
    }
    if (image.data.size === 0) throw new Error(`Kimi image ${image.name} is empty.`)
    if (image.data.size > limits.maxBytesPerImage) {
      throw new Error(`Kimi image ${image.name} exceeds the per-image byte limit.`)
    }
    if ((image.width ?? 0) > limits.maxWidth || (image.height ?? 0) > limits.maxHeight) {
      throw new Error(`Kimi image ${image.name} exceeds the dimension limit.`)
    }
    batchBytes += image.data.size
  }
  if (batchBytes > limits.maxBatchBytes) {
    throw new Error('Kimi image batch exceeds the total byte limit.')
  }
}

function validateImageRegion(region: KimiRegion): void {
  if (region !== 'cn') {
    throw new Error('Kimi image preparation is currently limited to the cn region.')
  }
}

function filesBaseUrl(options: KimiImagePreparationOptions): string {
  return kimiBaseUrl(options.region).replace(/\/+$/, '')
}

function authorization(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` }
}

async function uploadImage(
  image: KimiLocalImage,
  options: KimiImagePreparationOptions,
): Promise<UploadedKimiImage> {
  options.signal?.throwIfAborted()
  const form = new FormData()
  form.append('purpose', 'image')
  form.append('file', image.data, image.name)
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${filesBaseUrl(options)}/files`, {
      method: 'POST',
      headers: authorization(options.apiKey),
      body: form,
      signal: options.signal,
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new Error('Kimi image upload transport failed.')
  }
  if (!response.ok) throw new Error(`Kimi image upload failed with HTTP ${response.status}.`)
  let payload: { id?: unknown }
  try {
    payload = await response.json() as { id?: unknown }
  } catch {
    throw new Error('Kimi image upload returned invalid JSON.')
  }
  if (typeof payload.id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(payload.id)) {
    throw new Error('Kimi image upload returned an invalid file id.')
  }
  return {
    fileId: payload.id,
    block: {
      type: 'image',
      source: {
        kind: 'provider-file',
        provider: 'kimi',
        scope: kimiReferenceScope(options.region),
        reference: `ms://${payload.id}`,
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
  uploads: readonly UploadedKimiImage[],
  options: KimiImagePreparationOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  // Cleanup intentionally ignores the user signal: cancellation must not strand files
  // that completed just before the abort became visible.
  await Promise.allSettled(uploads.map(({ fileId }) => Promise.resolve().then(() => fetchImpl(
    `${filesBaseUrl(options)}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE', headers: authorization(options.apiKey) },
  ))))
}

/** Uploads a complete batch and retains adapter-owned rollback for Core transaction rejection. */
export async function prepareKimiImageBatch(
  images: readonly KimiLocalImage[],
  options: KimiImagePreparationOptions,
): Promise<PreparedKimiImageBatch> {
  validateImageRegion(options.region)
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

/** Compatibility helper for callers that commit the returned references immediately. */
export async function prepareKimiImages(
  images: readonly KimiLocalImage[],
  options: KimiImagePreparationOptions,
): Promise<UserImageContentBlock[]> {
  return [...(await prepareKimiImageBatch(images, options)).blocks]
}
