import { BoundedImageBytes } from './boundedImageBytes'

const FEATURE_ICCP = 0x20
const FEATURE_ALPHA = 0x10
const FEATURE_EXIF = 0x08
const FEATURE_XMP = 0x04
const FEATURE_ANIMATION = 0x02

function malformed(): never {
  throw new Error('malformed WebP container')
}

function uint24LE(reader: BoundedImageBytes, offset: number): number {
  return reader.uint8(offset) + (reader.uint8(offset + 1) * 256)
    + (reader.uint8(offset + 2) * 65_536)
}

function parseVp8(reader: BoundedImageBytes, offset: number, length: number) {
  if (length < 10 || !reader.has(offset, length)) malformed()
  const frameTag = reader.uint8(offset) + (reader.uint8(offset + 1) * 256)
    + (reader.uint8(offset + 2) * 65_536)
  const partitionLength = Math.floor(frameTag / 32)
  if ((frameTag & 1) !== 0 || ((frameTag >>> 1) & 7) > 3
    || ((frameTag >>> 4) & 1) !== 1 || partitionLength > length - 10
    || !reader.matches(offset + 3, [0x9d, 0x01, 0x2a])) malformed()
  const rawWidth = reader.uint16LE(offset + 6)
  const rawHeight = reader.uint16LE(offset + 8)
  if ((rawWidth & 0xc000) !== 0 || (rawHeight & 0xc000) !== 0) malformed()
  return { width: rawWidth, height: rawHeight, alpha: false }
}

function parseVp8l(reader: BoundedImageBytes, offset: number, length: number) {
  if (length < 5 || !reader.has(offset, length) || reader.uint8(offset) !== 0x2f) malformed()
  const bits = reader.uint32LE(offset + 1)
  if ((bits >>> 29) !== 0) malformed()
  return {
    width: 1 + (bits & 0x3fff),
    height: 1 + ((bits >>> 14) & 0x3fff),
    alpha: ((bits >>> 28) & 1) === 1,
  }
}

function parseVp8x(reader: BoundedImageBytes, offset: number, length: number) {
  if (length !== 10 || !reader.has(offset, length)) malformed()
  const flags = reader.uint8(offset)
  if ((flags & 0xc1) !== 0 || reader.uint8(offset + 1) !== 0
    || reader.uint8(offset + 2) !== 0 || reader.uint8(offset + 3) !== 0) malformed()
  return {
    flags,
    width: 1 + uint24LE(reader, offset + 4),
    height: 1 + uint24LE(reader, offset + 7),
  }
}

function sameDimensions(
  left: { readonly width: number; readonly height: number },
  right: { readonly width: number; readonly height: number },
) {
  return left.width === right.width && left.height === right.height
}

function readChunk(reader: BoundedImageBytes, offset: number, end = reader.length) {
  if (!reader.has(offset, 8) || offset + 8 > end) malformed()
  const length = reader.uint32LE(offset + 4)
  const dataOffset = offset + 8
  const paddedLength = length + (length % 2)
  if (paddedLength > end - dataOffset) malformed()
  if (length % 2 === 1 && reader.uint8(dataOffset + length) !== 0) malformed()
  return {
    type: String.fromCharCode(...reader.slice(offset, 4)),
    length,
    dataOffset,
    nextOffset: dataOffset + paddedLength,
  }
}

function parseImageChunk(reader: BoundedImageBytes, type: string, offset: number, length: number) {
  if (type === 'VP8 ') return parseVp8(reader, offset, length)
  if (type === 'VP8L') return parseVp8l(reader, offset, length)
  return malformed()
}

function validateAlphaChunk(reader: BoundedImageBytes, offset: number, length: number) {
  if (length < 1 || (reader.uint8(offset) & 0xe3) !== 0) malformed()
}

function parseAnimationFrame(
  reader: BoundedImageBytes,
  offset: number,
  length: number,
  canvas: { readonly width: number; readonly height: number },
) {
  if (length < 16) malformed()
  const x = uint24LE(reader, offset) * 2
  const y = uint24LE(reader, offset + 3) * 2
  const width = 1 + uint24LE(reader, offset + 6)
  const height = 1 + uint24LE(reader, offset + 9)
  if ((reader.uint8(offset + 15) & 0xfc) !== 0 || x > canvas.width || y > canvas.height
    || width > canvas.width - x || height > canvas.height - y) malformed()
  const end = offset + length
  let nestedOffset = offset + 16
  let alpha = false
  let image: ReturnType<typeof parseImageChunk> | undefined
  while (nestedOffset < end) {
    const chunk = readChunk(reader, nestedOffset, end)
    if (chunk.type === 'ALPH') {
      if (alpha || image) malformed()
      validateAlphaChunk(reader, chunk.dataOffset, chunk.length)
      alpha = true
    } else if (chunk.type === 'VP8 ' || chunk.type === 'VP8L') {
      if (image || alpha && chunk.type !== 'VP8 ') malformed()
      image = parseImageChunk(reader, chunk.type, chunk.dataOffset, chunk.length)
    } else {
      malformed()
    }
    nestedOffset = chunk.nextOffset
  }
  if (!image || !sameDimensions(image, { width, height })) malformed()
  return alpha || image.alpha
}

/** Validates WebP RIFF/features/bitstream headers and extracts canvas dimensions. */
export function parseWebpStaticContainer(bytes: Uint8Array) {
  const reader = new BoundedImageBytes(bytes)
  if (reader.length < 12 || !reader.ascii(0, 'RIFF') || !reader.ascii(8, 'WEBP')
    || reader.uint32LE(4) !== reader.length - 8) malformed()
  let offset = 12
  let extended: ReturnType<typeof parseVp8x> | undefined
  let image: ReturnType<typeof parseImageChunk> | undefined
  let sawIccp = false
  let sawAlpha = false
  let sawAnim = false
  let frameCount = 0
  let animationAlpha = false
  let sawExif = false
  let sawXmp = false

  while (offset < reader.length) {
    const chunk = readChunk(reader, offset)
    if (sawAlpha && !image && chunk.type !== 'VP8 ') malformed()
    if (chunk.type === 'VP8X') {
      if (offset !== 12 || extended) malformed()
      extended = parseVp8x(reader, chunk.dataOffset, chunk.length)
    } else if (!extended) {
      if (offset !== 12 || image || (chunk.type !== 'VP8 ' && chunk.type !== 'VP8L')) malformed()
      image = parseImageChunk(reader, chunk.type, chunk.dataOffset, chunk.length)
    } else if (chunk.type === 'ICCP') {
      if (sawIccp || image || sawAnim || frameCount > 0 || sawExif || sawXmp || chunk.length === 0) malformed()
      sawIccp = true
    } else if (chunk.type === 'ALPH') {
      if (sawAlpha || image || sawAnim || frameCount > 0 || sawExif || sawXmp) malformed()
      validateAlphaChunk(reader, chunk.dataOffset, chunk.length)
      sawAlpha = true
    } else if (chunk.type === 'VP8 ' || chunk.type === 'VP8L') {
      if (image || sawAnim || frameCount > 0 || sawExif || sawXmp
        || sawAlpha && chunk.type !== 'VP8 ') malformed()
      image = parseImageChunk(reader, chunk.type, chunk.dataOffset, chunk.length)
    } else if (chunk.type === 'ANIM') {
      if (sawAnim || image || sawAlpha || frameCount > 0 || sawExif || sawXmp || chunk.length !== 6) malformed()
      sawAnim = true
    } else if (chunk.type === 'ANMF') {
      if (!sawAnim || image || sawExif || sawXmp) malformed()
      animationAlpha ||= parseAnimationFrame(reader, chunk.dataOffset, chunk.length, extended)
      frameCount += 1
    } else if (chunk.type === 'EXIF') {
      if (sawExif || sawXmp || (!image && frameCount === 0) || chunk.length === 0) malformed()
      sawExif = true
    } else if (chunk.type === 'XMP ') {
      if (sawXmp || (!image && frameCount === 0) || chunk.length === 0) malformed()
      sawXmp = true
    }
    offset = chunk.nextOffset
  }
  if (offset !== reader.length) malformed()
  if (!extended) {
    if (!image) malformed()
    return { width: image.width, height: image.height, animated: false }
  }
  const animated = sawAnim || frameCount > 0
  if (animated ? !sawAnim || frameCount === 0 || image : !image) malformed()
  if (image && !sameDimensions(extended, image)) malformed()
  if (((extended.flags & FEATURE_ICCP) !== 0) !== sawIccp
    || ((extended.flags & FEATURE_EXIF) !== 0) !== sawExif
    || ((extended.flags & FEATURE_XMP) !== 0) !== sawXmp
    || ((extended.flags & FEATURE_ANIMATION) !== 0) !== animated
    || ((extended.flags & FEATURE_ALPHA) !== 0) !== (animated ? animationAlpha : sawAlpha || image?.alpha)) {
    malformed()
  }
  return { width: extended.width, height: extended.height, animated }
}
