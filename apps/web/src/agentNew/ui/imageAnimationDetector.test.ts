import { describe, expect, it } from 'vitest'
import { isAnimatedImage } from './imageAnimationDetector'

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
const webpHeader = [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]

function pngWithChunk(type: string) {
  return new File([new Uint8Array([...pngSignature, 0, 0, 0, 0, ...type.split('').map((char) => char.charCodeAt(0)), 0, 0, 0, 0])], 'image.png', { type: 'image/png' })
}

function webpWithChunk(type: string, payload: number[]) {
  const length = payload.length
  return new File([new Uint8Array([
    ...webpHeader,
    ...type.split('').map((char) => char.charCodeAt(0)),
    length, 0, 0, 0,
    ...payload,
    ...(length & 1 ? [0] : []),
  ])], 'image.webp', { type: 'image/webp' })
}

describe('image animation detector', () => {
  it('识别 APNG 的 acTL chunk', async () => {
    await expect(isAnimatedImage(pngWithChunk('acTL'))).resolves.toBe(true)
  })

  it('识别 animated WebP 的 ANIM chunk 或 VP8X animation flag', async () => {
    await expect(isAnimatedImage(webpWithChunk('ANIM', [0, 0, 0, 0, 0, 0]))).resolves.toBe(true)
    await expect(isAnimatedImage(webpWithChunk('VP8X', [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).resolves.toBe(true)
  })

  it('不把静态 WebP 的 VP8X 容器标记为动图', async () => {
    await expect(isAnimatedImage(webpWithChunk('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).resolves.toBe(false)
  })
})
