/** Bounds-checks every primitive read from an image container. */
export class BoundedImageBytes {
  readonly length: number
  readonly #bytes: Uint8Array
  readonly #view: DataView

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.length = bytes.length
  }

  has(offset: number, length: number): boolean {
    return Number.isSafeInteger(offset) && Number.isSafeInteger(length)
      && offset >= 0 && length >= 0 && offset <= this.length
      && length <= this.length - offset
  }

  remaining(offset: number): number {
    if (!this.has(offset, 0)) throw new RangeError('image container offset is out of bounds')
    return this.length - offset
  }

  uint8(offset: number): number {
    this.#require(offset, 1)
    return this.#view.getUint8(offset)
  }

  uint16BE(offset: number): number {
    this.#require(offset, 2)
    return this.#view.getUint16(offset, false)
  }

  uint16LE(offset: number): number {
    this.#require(offset, 2)
    return this.#view.getUint16(offset, true)
  }

  uint32BE(offset: number): number {
    this.#require(offset, 4)
    return this.#view.getUint32(offset, false)
  }

  uint32LE(offset: number): number {
    this.#require(offset, 4)
    return this.#view.getUint32(offset, true)
  }

  matches(offset: number, expected: readonly number[]): boolean {
    return this.has(offset, expected.length)
      && expected.every((byte, index) => this.#bytes[offset + index] === byte)
  }

  ascii(offset: number, expected: string): boolean {
    return this.has(offset, expected.length)
      && [...expected].every((character, index) => (
        this.#bytes[offset + index] === character.charCodeAt(0)
      ))
  }

  slice(offset: number, length: number): Uint8Array {
    this.#require(offset, length)
    return this.#bytes.subarray(offset, offset + length)
  }

  #require(offset: number, length: number) {
    if (!this.has(offset, length)) throw new RangeError('image container read is out of bounds')
  }
}
