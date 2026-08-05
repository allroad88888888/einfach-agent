function chunkType(bytes: Uint8Array, offset: number, type: string) {
  return type.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function pngHasAnimationControl(bytes: Uint8Array) {
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    const dataEnd = offset + 8 + length
    if (length < 0 || dataEnd + 4 > bytes.length) return false
    if (chunkType(bytes, offset + 4, 'acTL')) return true
    offset = dataEnd + 4
  }
  return false
}

function webpHasAnimation(bytes: Uint8Array) {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const length = bytes[offset + 4]
      | (bytes[offset + 5] << 8)
      | (bytes[offset + 6] << 16)
      | (bytes[offset + 7] << 24)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + length
    if (length < 0 || dataEnd > bytes.length) return false
    if (chunkType(bytes, offset, 'ANIM')) return true
    if (chunkType(bytes, offset, 'VP8X') && (bytes[dataOffset] & 0x02) !== 0) return true
    offset = dataEnd + (length & 1)
  }
  return false
}

async function readFileBytes(file: File) {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer())
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('无法读取图片。'))
    reader.readAsArrayBuffer(file)
  })
}

/** Detects APNG and animated WebP container markers without decoding image frames. */
export async function isAnimatedImage(file: File) {
  const bytes = await readFileBytes(file)
  if (file.type === 'image/png') return pngHasAnimationControl(bytes)
  if (file.type === 'image/webp') return webpHasAnimation(bytes)
  return false
}
