import { describe, expect, it } from 'vitest'
import { inspectStaticImage } from './staticImagePolicy'
import {
  asBlob,
  jpegBytes,
  malformedReviewContainers,
  progressiveJpegBytes,
} from './staticImagePolicy.testFixtures'

const limits = { maxWidth: 4096, maxHeight: 2160 }

function inspect(bytes: readonly number[]) {
  return inspectStaticImage(asBlob(bytes, 'image/jpeg'), 'image/jpeg', limits)
}

describe('JPEG static container policy', () => {
  it('记录 SOF 尺寸后验证 SOS、entropy scan 与 EOI', async () => {
    await expect(inspect(jpegBytes(1600, 900))).resolves.toEqual({ width: 1600, height: 900 })
  })

  it('支持 progressive 多 scan、ff00 stuffing、RST 与 marker fill bytes', async () => {
    await expect(inspect(progressiveJpegBytes(800, 600))).resolves.toEqual({ width: 800, height: 600 })
  })

  it.each([
    ['missing dimensions', [0xff, 0xd8, 0xff, 0xd9]],
    ['truncated segment', [0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]],
    ['SOF without SOS/EOI', malformedReviewContainers[0].bytes],
    ['SOF sampling 00', malformedReviewContainers[5].bytes],
    ['SOF quantization selector 04', malformedReviewContainers[6].bytes],
    ['truncated entropy stuffing', [...jpegBytes(1, 1).slice(0, -2), 0xff]],
  ])('拒绝 %s', async (_label, bytes) => {
    await expect(inspect(bytes)).rejects.toMatchObject({ code: 'invalid' })
  })
})
