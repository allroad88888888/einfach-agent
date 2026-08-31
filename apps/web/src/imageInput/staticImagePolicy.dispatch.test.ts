import { describe, expect, it } from 'vitest'
import { inspectStaticImage } from './staticImagePolicy'
import { asBlob, jpegBytes, pngBytes, webpLosslessBytes } from './staticImagePolicy.testFixtures'

const limits = { maxWidth: 4096, maxHeight: 2160 }

describe('static image policy dispatch and limits', () => {
  it.each([
    ['unknown MIME', asBlob(pngBytes(10, 10), 'image/png'), 'image/gif'],
    ['MIME/signature mismatch', asBlob(jpegBytes(10, 10), 'image/jpeg'), 'image/png'],
  ])('%s fail-closed', async (_label, blob, mimeType) => {
    await expect(inspectStaticImage(blob, mimeType, limits)).rejects.toMatchObject({ code: 'invalid' })
  })

  it.each([
    ['PNG width', pngBytes(4097, 2160), 'image/png'],
    ['PNG height', pngBytes(4096, 2161), 'image/png'],
    ['WebP', webpLosslessBytes(8192, 8192), 'image/webp'],
  ])('拒绝超过预算的 %s', async (_label, bytes, mimeType) => {
    await expect(inspectStaticImage(asBlob(bytes, mimeType), mimeType, limits))
      .rejects.toMatchObject({ code: 'dimensions' })
  })

  it('拒绝无效 policy limits', async () => {
    await expect(inspectStaticImage(
      asBlob(pngBytes(10, 10), 'image/png'),
      'image/png',
      { maxWidth: Number.MAX_SAFE_INTEGER + 1, maxHeight: 2160 },
    )).rejects.toMatchObject({ code: 'dimensions' })
  })
})
