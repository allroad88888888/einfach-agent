import { BoundedImageBytes } from './boundedImageBytes'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const KNOWN_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])

function malformed(): never {
  throw new Error('malformed PNG container')
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0)) >>> 0
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function readChunkType(reader: BoundedImageBytes, offset: number): string {
  const codes = [0, 1, 2, 3].map((index) => reader.uint8(offset + index))
  if (codes.some((code) => !((code >= 65 && code <= 90) || (code >= 97 && code <= 122)))) {
    malformed()
  }
  if ((codes[2] & 0x20) !== 0) malformed()
  return String.fromCharCode(...codes)
}

function validColorMode(bitDepth: number, colorType: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth)
  if (colorType === 2 || colorType === 4 || colorType === 6) {
    return bitDepth === 8 || bitDepth === 16
  }
  return colorType === 3 && [1, 2, 4, 8].includes(bitDepth)
}

/** Validates PNG chunks including CRC32 and extracts IHDR dimensions. */
export function parsePngStaticContainer(bytes: Uint8Array) {
  const reader = new BoundedImageBytes(bytes)
  if (!reader.matches(0, PNG_SIGNATURE)) malformed()
  let offset = PNG_SIGNATURE.length
  let dimensions: { width: number; height: number } | undefined
  let bitDepth: number | undefined
  let colorType: number | undefined
  let animated = false
  let sawAnimationControl = false
  let sawPalette = false
  let sawImageData = false
  let imageDataEnded = false
  let firstChunk = true

  while (reader.has(offset, 12)) {
    const length = reader.uint32BE(offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const available = reader.remaining(dataOffset)
    if (available < 4 || length > available - 4) malformed()
    const type = readChunkType(reader, typeOffset)
    const expectedCrc = reader.uint32BE(dataOffset + length)
    if (crc32(reader.slice(typeOffset, 4 + length)) !== expectedCrc) malformed()
    if (firstChunk && type !== 'IHDR') malformed()
    if (sawImageData && type !== 'IDAT' && type !== 'IEND') imageDataEnded = true

    if (type === 'IHDR') {
      if (!firstChunk || length !== 13 || dimensions) malformed()
      const width = reader.uint32BE(dataOffset)
      const height = reader.uint32BE(dataOffset + 4)
      bitDepth = reader.uint8(dataOffset + 8)
      colorType = reader.uint8(dataOffset + 9)
      if (!validColorMode(bitDepth, colorType)
        || reader.uint8(dataOffset + 10) !== 0 || reader.uint8(dataOffset + 11) !== 0
        || reader.uint8(dataOffset + 12) > 1) malformed()
      dimensions = { width, height }
    } else if (type === 'PLTE') {
      if (sawPalette || sawImageData || colorType === 0 || colorType === 4
        || length === 0 || length > 768 || length % 3 !== 0
        || colorType === 3 && (bitDepth === undefined || length / 3 > 2 ** bitDepth)) malformed()
      sawPalette = true
    } else if (type === 'acTL') {
      if (sawAnimationControl || sawImageData || length !== 8
        || reader.uint32BE(dataOffset) === 0) malformed()
      sawAnimationControl = true
      animated = true
    } else if (type === 'fcTL') {
      if (!sawAnimationControl || length !== 26) malformed()
      animated = true
    } else if (type === 'fdAT') {
      if (!sawAnimationControl || !sawImageData || length < 4) malformed()
      animated = true
    } else if (type === 'IDAT') {
      if (imageDataEnded || colorType === 3 && !sawPalette) malformed()
      sawImageData = true
    } else if (type === 'IEND') {
      if (length !== 0 || offset + 12 !== reader.length || !sawImageData || !dimensions) malformed()
      return { ...dimensions, animated }
    } else if ((type.charCodeAt(0) & 0x20) === 0 && !KNOWN_CRITICAL_CHUNKS.has(type)) {
      malformed()
    }
    offset = dataOffset + length + 4
    firstChunk = false
  }
  return malformed()
}
