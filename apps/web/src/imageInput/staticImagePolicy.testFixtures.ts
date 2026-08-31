function u16be(value: number) {
  return [(value >>> 8) & 0xff, value & 0xff]
}

function u32be(value: number) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u32le(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function text(value: string) {
  return [...value].map((character) => character.charCodeAt(0))
}

function crc32(bytes: readonly number[]) {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0)) >>> 0
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function pngChunk(type: string, payload: readonly number[]) {
  const checked = [...text(type), ...payload]
  return [...u32be(payload.length), ...checked, ...u32be(crc32(checked))]
}

export function pngBytes(width: number, height: number, animated = false): number[] {
  return [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...(animated ? pngChunk('acTL', [...u32be(1), ...u32be(0)]) : []),
    ...pngChunk('IDAT', []),
    ...pngChunk('IEND', []),
  ]
}

export function indexedPngBytes(bitDepth: 1 | 2 | 4 | 8, paletteEntries: number): number[] {
  const palette = Array.from({ length: paletteEntries }, (_, index) => [index, index, index]).flat()
  return [
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk('IHDR', [...u32be(1), ...u32be(1), bitDepth, 3, 0, 0, 0]),
    ...pngChunk('PLTE', palette),
    ...pngChunk('IDAT', []),
    ...pngChunk('IEND', []),
  ]
}

export function jpegBytes(width: number, height: number): number[] {
  return [
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, ...u16be(11), 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0,
    0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0,
    0,
    0xff, 0xd9,
  ]
}

export function progressiveJpegBytes(width: number, height: number): number[] {
  const scan = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0]
  return [
    0xff, 0xd8,
    0xff, 0xc2, ...u16be(11), 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0,
    ...scan, 1, 0xff, 0x00, 2, 0xff, 0xd0, 3,
    0xff, 0xff, ...scan.slice(1), 4,
    0xff, 0xd9,
  ]
}

export function webpChunkBytes(type: string, payload: readonly number[]) {
  return [
    ...text(type), ...u32le(payload.length), ...payload,
    ...(payload.length % 2 === 1 ? [0] : []),
  ]
}

function vp8lPayload(width: number, height: number) {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0
  return [0x2f, ...u32le(bits)]
}

function vp8xPayload(width: number, height: number, flags: number) {
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  return [
    flags, 0, 0, 0,
    widthMinusOne & 0xff, (widthMinusOne >>> 8) & 0xff, (widthMinusOne >>> 16) & 0xff,
    heightMinusOne & 0xff, (heightMinusOne >>> 8) & 0xff, (heightMinusOne >>> 16) & 0xff,
  ]
}

export function webpRiffBytes(chunks: readonly number[]) {
  return [...text('RIFF'), ...u32le(chunks.length + 4), ...text('WEBP'), ...chunks]
}

export function webpLosslessBytes(width: number, height: number): number[] {
  return webpRiffBytes(webpChunkBytes('VP8L', vp8lPayload(width, height)))
}

export function webpLossyBytes(width: number, height: number): number[] {
  const frame = [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...u16be(width).reverse(), ...u16be(height).reverse()]
  return webpRiffBytes(webpChunkBytes('VP8 ', frame))
}

export function webpExtendedBytes(width: number, height: number): number[] {
  return webpRiffBytes([
    ...webpChunkBytes('VP8X', vp8xPayload(width, height, 0)),
    ...webpChunkBytes('VP8L', vp8lPayload(width, height)),
  ])
}

export function webpExtendedFeatureBytes(width: number, height: number): number[] {
  const lossy = [0x10, 0, 0, 0x9d, 0x01, 0x2a, ...u16be(width).reverse(), ...u16be(height).reverse()]
  return webpRiffBytes([
    ...webpChunkBytes('VP8X', vp8xPayload(width, height, 0x3c)),
    ...webpChunkBytes('ICCP', [1]),
    ...webpChunkBytes('ALPH', [0]),
    ...webpChunkBytes('VP8 ', lossy),
    ...webpChunkBytes('EXIF', [1]),
    ...webpChunkBytes('XMP ', [1]),
  ])
}

export function animatedWebpBytes(
  width: number,
  height: number,
  marker: 'ANIM' | 'VP8X',
): number[] {
  const frameHeader = [
    0, 0, 0, 0, 0, 0,
    (width - 1) & 0xff, ((width - 1) >>> 8) & 0xff, ((width - 1) >>> 16) & 0xff,
    (height - 1) & 0xff, ((height - 1) >>> 8) & 0xff, ((height - 1) >>> 16) & 0xff,
    0, 0, 0, 0,
  ]
  const frame = webpChunkBytes('ANMF', [
    ...frameHeader,
    ...webpChunkBytes('VP8L', vp8lPayload(width, height)),
  ])
  const chunks = [
    ...webpChunkBytes('VP8X', vp8xPayload(width, height, 0x02)),
    ...webpChunkBytes('ANIM', [0, 0, 0, 0, 0, 0]),
    ...frame,
  ]
  if (marker !== 'ANIM' && marker !== 'VP8X') throw new Error('unsupported animation marker')
  return webpRiffBytes(chunks)
}

export function asBlob(bytes: readonly number[], mimeType: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType })
}

export function asBase64(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes))
}

export const malformedReviewContainers = [
  {
    label: 'JPEG SOF without SOS/EOI',
    mimeType: 'image/jpeg',
    bytes: [
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00,
      0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    ],
  },
  {
    label: 'PNG zero CRC',
    mimeType: 'image/png',
    bytes: [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
      8, 6, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
    ],
  },
  {
    label: 'WebP VP8 inter frame',
    mimeType: 'image/webp',
    bytes: [
      0x52, 0x49, 0x46, 0x46, 0x16, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x20, 0x0a, 0, 0, 0, 1, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0,
    ],
  },
  {
    label: 'WebP VP8L non-zero version',
    mimeType: 'image/webp',
    bytes: [
      0x52, 0x49, 0x46, 0x46, 0x12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f, 0, 0, 0, 0x20, 0,
    ],
  },
  {
    label: 'WebP VP8X non-zero reserved byte',
    mimeType: 'image/webp',
    bytes: [
      0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
      0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0,
    ],
  },
  {
    label: 'JPEG SOF sampling 00',
    mimeType: 'image/jpeg',
    bytes: [
      0xff, 0xd8, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
    ],
  },
  {
    label: 'JPEG SOF quantization selector 04',
    mimeType: 'image/jpeg',
    bytes: [
      0xff, 0xd8, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 4,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
    ],
  },
  {
    label: 'PNG indexed palette exceeds bit depth',
    mimeType: 'image/png',
    bytes: [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
      1, 3, 0, 0, 0, 0x25, 0xdb, 0x56, 0xca,
      0, 0, 0, 9, 0x50, 0x4c, 0x54, 0x45, 0, 0, 0, 0xff, 0xff, 0xff,
      0xff, 0, 0, 0xcd, 0x5e, 0xb7, 0x9c,
      0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0x35, 0xaf, 6, 0x1e,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ],
  },
] as const
