import {
  PROVIDER_TRANSPORT_LIMITS as LIMITS,
  isValidProviderContentType,
  isValidProviderFileName,
  isValidProviderPartName,
  type ProviderMultipartPart,
  type ProviderTransportInput,
  type ProviderWireMultipartPart,
  type ProviderWireRequestBody,
} from '@einfach-agent/ai'
import { providerRouteSpec } from './providerRoute'

const textEncoder = new TextEncoder()

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

function invalidBody(): never {
  throw new Error('模型请求格式无效')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function validatePartName(name: string): void {
  if (!isValidProviderPartName(name)) invalidBody()
}

function validateFileMetadata(part: Extract<ProviderMultipartPart, { kind: 'file' }>): void {
  if (!isValidProviderFileName(part.fileName)) invalidBody()
  if (!isValidProviderContentType(part.contentType)) invalidBody()
}

function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('模型文件读取失败'))
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('模型文件读取失败'))
    }
    reader.readAsArrayBuffer(blob)
  })
}

function arrayBufferWithAbort(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  throwIfAborted(signal)
  const reading = blobArrayBuffer(blob)
  if (!signal) return reading
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException(
      'The operation was aborted.',
      'AbortError',
    ))
    signal.addEventListener('abort', onAbort, { once: true })
    void reading.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function encodeFilePart(
  part: Extract<ProviderMultipartPart, { kind: 'file' }>,
  signal?: AbortSignal,
): Promise<ProviderWireMultipartPart> {
  validateFileMetadata(part)
  const buffer = await arrayBufferWithAbort(part.data, signal)
  throwIfAborted(signal)
  return {
    kind: 'file',
    name: part.name,
    fileName: part.fileName,
    contentType: part.contentType,
    bytesBase64: bytesToBase64(new Uint8Array(buffer)),
  }
}

async function encodeMultipart(
  parts: readonly ProviderMultipartPart[],
  signal?: AbortSignal,
): Promise<ProviderWireRequestBody> {
  if (parts.length === 0 || parts.length > LIMITS.maxMultipartParts) invalidBody()
  const output: ProviderWireMultipartPart[] = []
  let fileCount = 0
  let fileBytes = 0
  let textBytes = 0
  for (const part of parts) {
    throwIfAborted(signal)
    validatePartName(part.name)
    if (part.kind === 'text') {
      const size = byteLength(part.value)
      textBytes += size
      if (size > LIMITS.maxMultipartTextBytes
        || textBytes > LIMITS.maxMultipartTextBatchBytes) invalidBody()
      output.push(part)
      continue
    }
    fileCount += 1
    fileBytes += part.data.size
    if (part.data.size === 0
      || part.data.size > LIMITS.maxMultipartFileBytes
      || fileCount > LIMITS.maxMultipartFiles
      || fileBytes > LIMITS.maxMultipartBatchBytes) invalidBody()
    output.push(await encodeFilePart(part, signal))
  }
  return { kind: 'multipart', parts: output }
}

export async function encodeProviderWireBody(
  input: ProviderTransportInput,
): Promise<ProviderWireRequestBody> {
  const expected = providerRouteSpec(input.target).bodyKind
  if (input.body.kind !== expected) invalidBody()
  if (input.body.kind === 'none') return input.body
  if (input.body.kind === 'json') {
    if (byteLength(input.body.json) > LIMITS.maxJsonBytes) invalidBody()
    try {
      JSON.parse(input.body.json)
    } catch {
      return invalidBody()
    }
    return input.body
  }
  return encodeMultipart(input.body.parts, input.signal)
}
