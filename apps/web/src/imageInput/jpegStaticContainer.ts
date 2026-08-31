import { BoundedImageBytes } from './boundedImageBytes'

const JPEG_START = [0xff, 0xd8] as const
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2,
  0xc9, 0xca,
])

function malformed(): never {
  throw new Error('malformed JPEG container')
}

function isRestartMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7
}

function readMarker(reader: BoundedImageBytes, start: number) {
  if (reader.uint8(start) !== 0xff) malformed()
  let offset = start
  while (offset < reader.length && reader.uint8(offset) === 0xff) offset += 1
  if (offset >= reader.length) malformed()
  const marker = reader.uint8(offset)
  if (marker === 0x00 || marker === 0xff) malformed()
  return { marker, offset: offset + 1 }
}

function readEntropyMarker(reader: BoundedImageBytes, start: number) {
  let offset = start
  while (offset < reader.length) {
    if (reader.uint8(offset) !== 0xff) {
      offset += 1
      continue
    }
    while (offset < reader.length && reader.uint8(offset) === 0xff) offset += 1
    if (offset >= reader.length) malformed()
    const marker = reader.uint8(offset)
    offset += 1
    if (marker === 0x00 || isRestartMarker(marker)) continue
    return { marker, offset }
  }
  return malformed()
}

function readSegmentLength(reader: BoundedImageBytes, offset: number): number {
  const length = reader.uint16BE(offset)
  if (length < 2 || !reader.has(offset, length)) malformed()
  return length
}

function readStartOfFrame(reader: BoundedImageBytes, marker: number, offset: number, length: number) {
  if (length < 11) malformed()
  const precision = reader.uint8(offset + 2)
  const height = reader.uint16BE(offset + 3)
  const width = reader.uint16BE(offset + 5)
  const componentCount = reader.uint8(offset + 7)
  if ((marker === 0xc0 && precision !== 8) || (marker !== 0xc0 && precision !== 8 && precision !== 12)
    || width === 0 || height === 0 || componentCount === 0 || componentCount > 4
    || length !== 8 + (3 * componentCount)) malformed()
  const componentIds = new Set<number>()
  for (let index = 0; index < componentCount; index += 1) {
    const componentId = reader.uint8(offset + 8 + (index * 3))
    const sampling = reader.uint8(offset + 9 + (index * 3))
    const horizontalSampling = sampling >>> 4
    const verticalSampling = sampling & 0x0f
    const quantizationTable = reader.uint8(offset + 10 + (index * 3))
    if (componentId === 0 || componentIds.has(componentId)
      || horizontalSampling < 1 || horizontalSampling > 4
      || verticalSampling < 1 || verticalSampling > 4
      || quantizationTable > 3) malformed()
    componentIds.add(componentId)
  }
  return { width, height, componentIds }
}

function validateStartOfScan(
  reader: BoundedImageBytes,
  offset: number,
  length: number,
  frameComponents: ReadonlySet<number>,
  frameMarker: number,
) {
  if (length < 8) malformed()
  const componentCount = reader.uint8(offset + 2)
  if (componentCount === 0 || componentCount > frameComponents.size
    || length !== 6 + (2 * componentCount)) malformed()
  const scanComponents = new Set<number>()
  for (let index = 0; index < componentCount; index += 1) {
    const componentId = reader.uint8(offset + 3 + (index * 2))
    const tables = reader.uint8(offset + 4 + (index * 2))
    if (!frameComponents.has(componentId) || scanComponents.has(componentId)) malformed()
    if ((tables >>> 4) > 3 || (tables & 0x0f) > 3) malformed()
    scanComponents.add(componentId)
  }
  const parametersOffset = offset + 3 + (2 * componentCount)
  const spectralStart = reader.uint8(parametersOffset)
  const spectralEnd = reader.uint8(parametersOffset + 1)
  const approximation = reader.uint8(parametersOffset + 2)
  const high = approximation >>> 4
  const low = approximation & 0x0f
  const progressive = frameMarker === 0xc2 || frameMarker === 0xca
  if (progressive) {
    if (spectralStart > spectralEnd || spectralEnd > 63
      || (spectralStart === 0 && spectralEnd !== 0)
      || (spectralStart > 0 && componentCount !== 1)
      || high > 13 || low > 13 || (high !== 0 && high !== low + 1)) malformed()
  } else if (spectralStart !== 0 || spectralEnd !== 63 || high !== 0 || low !== 0) {
    malformed()
  }
}

/** Validates JPEG marker/scan closure and extracts SOF dimensions. */
export function parseJpegStaticContainer(bytes: Uint8Array) {
  const reader = new BoundedImageBytes(bytes)
  if (!reader.matches(0, JPEG_START)) malformed()
  let offset = 2
  let inEntropyScan = false
  let dimensions: { width: number; height: number } | undefined
  let frameComponents: ReadonlySet<number> | undefined
  let frameMarker: number | undefined
  let sawScan = false

  while (offset < reader.length) {
    const markerResult = inEntropyScan
      ? readEntropyMarker(reader, offset)
      : readMarker(reader, offset)
    const { marker } = markerResult
    offset = markerResult.offset
    inEntropyScan = false

    if (marker === 0xd9) {
      if (!dimensions || !sawScan || offset !== reader.length) malformed()
      return { ...dimensions, animated: false }
    }
    if (marker === 0xd8 || marker === 0x00 || isRestartMarker(marker)) malformed()
    if (marker === 0x01) continue

    const length = readSegmentLength(reader, offset)
    if (SOF_MARKERS.has(marker)) {
      if (dimensions) malformed()
      const frame = readStartOfFrame(reader, marker, offset, length)
      dimensions = { width: frame.width, height: frame.height }
      frameComponents = frame.componentIds
      frameMarker = marker
    } else if (marker === 0xda) {
      if (!frameComponents || frameMarker === undefined) malformed()
      validateStartOfScan(reader, offset, length, frameComponents, frameMarker)
      sawScan = true
      inEntropyScan = true
    }
    offset += length
  }
  return malformed()
}
