import { describe, expect, it } from 'vitest'
import { inspectStaticImage } from './staticImagePolicy'
import {
  asBlob,
  indexedPngBytes,
  malformedReviewContainers,
  pngBytes,
} from './staticImagePolicy.testFixtures'

const limits = { maxWidth: 4096, maxHeight: 2160 }

function inspect(bytes: readonly number[]) {
  return inspectStaticImage(asBlob(bytes, 'image/png'), 'image/png', limits)
}

describe('PNG static container policy', () => {
  it('验证真实 chunk CRC 并从 IHDR 读取边界尺寸', async () => {
    const bytes = pngBytes(4096, 2160)
    expect(bytes.slice(-4)).toEqual([0xae, 0x42, 0x60, 0x82])
    await expect(inspect(bytes)).resolves.toEqual({ width: 4096, height: 2160 })
  })

  it('识别 CRC 正确的 acTL 动画控制块', async () => {
    await expect(inspect(pngBytes(400, 300, true))).rejects.toMatchObject({ code: 'animated' })
  })

  it('拒绝 review 中所有 chunk CRC 为零的 PNG', async () => {
    await expect(inspect(malformedReviewContainers[1].bytes))
      .rejects.toMatchObject({ code: 'invalid' })
  })

  it('接受 indexed bit depth 1 的最大 2-entry palette', async () => {
    await expect(inspect(indexedPngBytes(1, 2))).resolves.toEqual({ width: 1, height: 1 })
  })

  it('拒绝 review 中 bit depth 1 却含 3-entry PLTE 的 PNG', async () => {
    await expect(inspect(malformedReviewContainers[7].bytes))
      .rejects.toMatchObject({ code: 'invalid' })
  })

  it('拒绝 uint32 chunk 长度越界且不发生有符号绕回', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0xff, 0xff, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52]
    await expect(inspect(bytes)).rejects.toMatchObject({ code: 'invalid' })
  })
})
