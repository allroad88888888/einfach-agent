import { describe, expect, it } from 'vitest'
import { inspectStaticImage } from './staticImagePolicy'
import {
  animatedWebpBytes,
  asBlob,
  malformedReviewContainers,
  webpChunkBytes,
  webpExtendedBytes,
  webpExtendedFeatureBytes,
  webpLosslessBytes,
  webpLossyBytes,
  webpRiffBytes,
} from './staticImagePolicy.testFixtures'

const limits = { maxWidth: 4096, maxHeight: 2160 }

function inspect(bytes: readonly number[]) {
  return inspectStaticImage(asBlob(bytes, 'image/webp'), 'image/webp', limits)
}

function hex(value: string) {
  return value.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16))
}

describe('WebP static container policy', () => {
  it.each([
    ['VP8', webpLossyBytes(800, 600), { width: 800, height: 600 }],
    ['VP8L', webpLosslessBytes(1600, 900), { width: 1600, height: 900 }],
    ['VP8X', webpExtendedBytes(1024, 512), { width: 1024, height: 512 }],
  ])('从合法 %s header 读取尺寸', async (_kind, bytes, dimensions) => {
    await expect(inspect(bytes)).resolves.toEqual(dimensions)
  })

  it('接受 flags 与 ICCP/ALPH/EXIF/XMP 顺序一致的 extended WebP', async () => {
    await expect(inspect(webpExtendedFeatureBytes(640, 480)))
      .resolves.toEqual({ width: 640, height: 480 })
  })

  it('识别结构完整的 ANIM/ANMF 与 VP8X animation flag', async () => {
    await expect(inspect(animatedWebpBytes(400, 300, 'ANIM')))
      .rejects.toMatchObject({ code: 'animated' })
    await expect(inspect(animatedWebpBytes(400, 300, 'VP8X')))
      .rejects.toMatchObject({ code: 'animated' })
  })

  it.each(malformedReviewContainers.slice(2))('拒绝 review 的 $label', async ({ bytes }) => {
    await expect(inspect(bytes)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('拒绝 RIFF/chunk 越界、缺 image data 与 feature flag 漂移', async () => {
    const oversized = hex(`
      52 49 46 46 0c 00 00 00 57 45 42 50
      56 50 38 4c ff ff ff ff
    `)
    const noImage = hex('52 49 46 46 04 00 00 00 57 45 42 50')
    const missingIccp = [...webpExtendedBytes(10, 10)]
    missingIccp[20] = 0x20
    await expect(inspect(oversized)).rejects.toMatchObject({ code: 'invalid' })
    await expect(inspect(noImage)).rejects.toMatchObject({ code: 'invalid' })
    await expect(inspect(missingIccp)).rejects.toMatchObject({ code: 'invalid' })
  })

  it.each([
    ['metadata order', (() => {
      const bytes = webpExtendedFeatureBytes(10, 10)
      return [...bytes.slice(0, 68), ...bytes.slice(78, 88), ...bytes.slice(68, 78)]
    })()],
    ['duplicate XMP', (() => {
      const bytes = webpExtendedFeatureBytes(10, 10)
      return webpRiffBytes([...bytes.slice(12), ...webpChunkBytes('XMP ', [2])])
    })()],
    ['animation without frame', (() => {
      const bytes = animatedWebpBytes(10, 10, 'ANIM')
      return webpRiffBytes(bytes.slice(12, 44))
    })()],
    ['duplicate simple image', (() => {
      const image = webpLosslessBytes(10, 10).slice(12)
      return webpRiffBytes([...image, ...image])
    })()],
  ])('拒绝 extended chunk %s 违规', async (_label, bytes) => {
    await expect(inspect(bytes)).rejects.toMatchObject({ code: 'invalid' })
  })
})
