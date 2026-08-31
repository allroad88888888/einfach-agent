import { describe, expect, it, vi } from 'vitest'
import { resizeVisionImage, type VisionResizePlatform } from './resizeVisionImage'
import {
  animatedWebpBytes,
  asBase64,
  pngBytes,
  webpLosslessBytes,
} from '../imageInput/staticImagePolicy.testFixtures'

function source(
  width: number,
  height: number,
  mimeType: 'image/png' | 'image/webp' = 'image/png',
  filename = 'diagram.png',
) {
  const bytes = mimeType === 'image/png'
    ? pngBytes(width, height)
    : webpLosslessBytes(width, height)
  return {
    base64: asBase64(bytes),
    mimeType,
    filename,
    sizeBytes: bytes.length,
  }
}

function blobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)])
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function platform(width: number, height: number, encoded = new Blob(['low'], { type: 'image/png' })) {
  const close = vi.fn()
  const encode = vi.fn().mockResolvedValue(encoded)
  const value: VisionResizePlatform = {
    decode: vi.fn().mockResolvedValue({ width, height, close }),
    encode,
  }
  return { value, close, encode, encoded }
}

describe('resizeVisionImage detail policy', () => {
  it('low 将大图真实等比缩入 512×512 包围盒', async () => {
    const surface = platform(1600, 900)
    const result = await resizeVisionImage(source(1600, 900), 'low', undefined, surface.value)

    expect(result).toMatchObject({
      width: 512,
      height: 288,
      mimeType: 'image/png',
      name: 'diagram.png',
      data: expect.objectContaining({ type: 'image/png' }),
    })
    expect(result.data).toBe(surface.encoded)
    expect(surface.encode).toHaveBeenCalledWith(expect.anything(), 512, 288, 'image/png')
    expect(surface.close).toHaveBeenCalledOnce()
  })

  it('low 对已在包围盒内的图片保留原字节', async () => {
    const original = pngBytes(400, 300)
    const surface = platform(400, 300)
    const result = await resizeVisionImage(source(400, 300), 'low', undefined, surface.value)

    expect(result).toMatchObject({ width: 400, height: 300 })
    await expect(blobBytes(result.data)).resolves.toEqual(original)
    expect(surface.encode).not.toHaveBeenCalled()
    expect(surface.close).toHaveBeenCalledOnce()
  })

  it('high 完整保留原始字节且不执行像素解码', async () => {
    const original = pngBytes(4096, 2160)
    const surface = platform(4096, 2160)
    const result = await resizeVisionImage(source(4096, 2160), 'high', undefined, surface.value)

    expect(result).toMatchObject({ width: 4096, height: 2160 })
    await expect(blobBytes(result.data)).resolves.toEqual(original)
    expect(surface.value.decode).not.toHaveBeenCalled()
    expect(surface.encode).not.toHaveBeenCalled()
  })

  it('low 请求 WebP 但编码器回退 PNG 时 fail-closed', async () => {
    const fallback = platform(1024, 512, new Blob(['png'], { type: 'image/png' }))

    await expect(resizeVisionImage(
      source(1024, 512, 'image/webp', 'diagram.webp'),
      'low',
      undefined,
      fallback.value,
    )).rejects.toThrow('重编码图片格式与原图不一致')
    expect(fallback.encode).toHaveBeenCalledWith(expect.anything(), 512, 256, 'image/webp')
    expect(fallback.close).toHaveBeenCalledOnce()
  })

  it('low 解码尺寸与容器元数据不一致时 fail-closed', async () => {
    const mismatched = platform(1600, 899)

    await expect(resizeVisionImage(source(1600, 900), 'low', undefined, mismatched.value))
      .rejects.toThrow('decoded image dimensions do not match container metadata')
    expect(mismatched.encode).not.toHaveBeenCalled()
    expect(mismatched.close).toHaveBeenCalledOnce()
  })

  it.each(['low', 'high'] as const)('%s 在像素解码前拒绝 APNG', async (detail) => {
    const bytes = pngBytes(400, 300, true)
    const surface = platform(400, 300)
    await expect(resizeVisionImage({
      ...source(400, 300),
      base64: asBase64(bytes),
      sizeBytes: bytes.length,
    }, detail, undefined, surface.value)).rejects.toMatchObject({ code: 'animated' })
    expect(surface.value.decode).not.toHaveBeenCalled()
  })

  it.each(['ANIM', 'VP8X'] as const)('拒绝 animated WebP %s marker', async (marker) => {
    const bytes = animatedWebpBytes(400, 300, marker)
    const surface = platform(400, 300)
    await expect(resizeVisionImage({
      base64: asBase64(bytes),
      mimeType: 'image/webp',
      filename: 'animated.webp',
      sizeBytes: bytes.length,
    }, 'high', undefined, surface.value)).rejects.toMatchObject({ code: 'animated' })
    expect(surface.value.decode).not.toHaveBeenCalled()
  })

  it('high 在像素解码前拒绝 8192×8192', async () => {
    const surface = platform(8192, 8192)
    await expect(resizeVisionImage(source(8192, 8192, 'image/webp'), 'high', undefined, surface.value))
      .rejects.toMatchObject({ code: 'dimensions' })
    expect(surface.value.decode).not.toHaveBeenCalled()
  })
})
