import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '@einfach/core'
import type { ImageInputCapability } from '@einfach-agent/ai'
import {
  addComposerImageAttachmentsAtom,
  composerImageAttachmentAtom,
} from './composerImageAttachmentState'
import {
  jpegBytes,
  malformedReviewContainers,
  pngBytes,
  webpLosslessBytes,
} from '../../imageInput/staticImagePolicy.testFixtures'

const capability: ImageInputCapability = {
  kind: 'provider-upload',
  accept: ['image/jpeg', 'image/png', 'image/webp'],
  limits: { maxImages: 8, maxBytesPerImage: 100, maxBatchBytes: 800, maxWidth: 100, maxHeight: 100 },
}

function png(name: string, width = 10, height = 10) {
  return new File([new Uint8Array(pngBytes(width, height))], name, { type: 'image/png' })
}

function animatedPng(name: string) {
  return new File([new Uint8Array(pngBytes(10, 10, true))], name, { type: 'image/png' })
}

function jpeg(name: string) {
  return new File([new Uint8Array(jpegBytes(10, 10))], name, { type: 'image/jpeg' })
}

function webp(name: string) {
  return new File([new Uint8Array(webpLosslessBytes(10, 10))], name, { type: 'image/webp' })
}

describe('composer image attachment state', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('批量校验 8 张边界，拒绝第九张但保留已有草稿', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, {
      files: Array.from({ length: 8 }, (_, index) => png(`${index}.png`)),
      capability,
    })
    await store.setter(addComposerImageAttachmentsAtom, { files: [png('nine.png')], capability })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: expect.arrayContaining([expect.objectContaining({ name: '0.png' })]),
      operation: 'idle',
      error: '最多可附加 8 张图片。',
    })
    expect(store.getter(composerImageAttachmentAtom).images).toHaveLength(8)
  })

  it('JPEG 和 WebP 的文件签名通过后可作为附件', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, {
      files: [jpeg('photo.jpg'), webp('photo.webp')],
      capability,
    })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [
        { name: 'photo.jpg', mimeType: 'image/jpeg' },
        { name: 'photo.webp', mimeType: 'image/webp' },
      ],
      operation: 'idle',
    })
  })

  it.each([
    [new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' }), '“vector.svg”不是当前模型支持的图片格式。'],
    [new File([], 'empty.png', { type: 'image/png' }), '“empty.png”不是有效的图片文件。'],
    [new File([new Uint8Array([255, 216, 0])], 'damaged.jpg', { type: 'image/jpeg' }), '“damaged.jpg”不是有效的图片文件。'],
  ])('拒绝不可用的图片文件 %#', async (file, error) => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, { files: [file], capability })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({ images: [], error })
  })

  it('批次总量等于上限时接受，多一字节时拒绝', async () => {
    const batchCapability: ImageInputCapability = {
      ...capability,
      limits: { ...capability.limits, maxBatchBytes: png('measure.png').size * 2 },
    }
    const atLimitStore = createStore()
    await atLimitStore.setter(addComposerImageAttachmentsAtom, {
      files: [png('first.png'), png('second.png')],
      capability: batchCapability,
    })
    expect(atLimitStore.getter(composerImageAttachmentAtom).images).toHaveLength(2)

    const overLimitStore = createStore()
    const nineBytes = new File([
      new Uint8Array(pngBytes(10, 10)),
      new Uint8Array([0]),
    ], 'nine-bytes.png', { type: 'image/png' })
    await overLimitStore.setter(addComposerImageAttachmentsAtom, {
      files: [png('first.png'), nineBytes],
      capability: batchCapability,
    })
    expect(overLimitStore.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [],
      error: '图片总大小不能超过 0.0 MB。',
    })
  })

  it('拒绝伪造 MIME 的文件，避免只按扩展名或 Content-Type 判断', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, {
      files: [new File(['not a png'], 'fake.png', { type: 'image/png' })],
      capability,
    })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [],
      error: '“fake.png”不是有效的图片文件。',
    })
  })

  it('拒绝超出单张体积限制的图片', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, {
      files: [new File([new Uint8Array(101)], 'large.png', { type: 'image/png' })],
      capability,
    })

    expect(store.getter(composerImageAttachmentAtom).error).toBe('“large.png”超过单张 0.0 MB 限制。')
  })

  it('读取真实解码尺寸并拒绝超出模型上限的图片', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, { files: [png('wide.png', 101, 100)], capability })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [],
      error: '图片尺寸不能超过 100 × 100。',
    })
  })

  it('maxHeight 等于上限时接受，超出时拒绝并保留已有附件', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, { files: [png('at-limit.png', 100, 100)], capability })
    await store.setter(addComposerImageAttachmentsAtom, { files: [png('too-tall.png', 100, 101)], capability })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [{ name: 'at-limit.png', height: 100 }],
      error: '图片尺寸不能超过 100 × 100。',
    })
  })

  it('拒绝 APNG 动图并给出静态图片提示', async () => {
    const store = createStore()
    await store.setter(addComposerImageAttachmentsAtom, { files: [animatedPng('animated.png')], capability })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [],
      error: '“animated.png”是动图，请选择静态图片。',
    })
  })

  it.each(malformedReviewContainers.filter(({ mimeType }) => mimeType !== 'image/webp'))('共享 policy 拒绝 $label', async ({
    bytes,
    mimeType,
  }) => {
    const store = createStore()
    const name = mimeType === 'image/jpeg' ? 'broken.jpg' : 'broken.png'
    await store.setter(addComposerImageAttachmentsAtom, {
      files: [new File([new Uint8Array(bytes)], name, { type: mimeType })],
      capability,
    })

    expect(store.getter(composerImageAttachmentAtom)).toMatchObject({
      images: [],
      error: `“${name}”不是有效的图片文件。`,
    })
  })
})
