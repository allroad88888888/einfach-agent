/** Raised when an unterminated JSONL line grows beyond its configured byte ceiling. */
export class JsonlLineTooLargeError extends Error {
  override readonly name = 'JsonlLineTooLargeError'
}

/** Accumulates fragmented JSONL input without repeatedly copying the unfinished line. */
export class BoundedJsonlBuffer {
  readonly #maxLineBytes: number
  #parts: Buffer[] = []
  #pendingBytes = 0

  constructor(maxLineBytes: number) {
    this.#maxLineBytes = maxLineBytes
  }

  get pendingBytes(): number {
    return this.#pendingBytes
  }

  append(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = []
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline < 0) {
        this.#appendPart(chunk.subarray(start))
        break
      }
      const tail = chunk.subarray(start, newline)
      if (this.#pendingBytes + tail.length > this.#maxLineBytes) {
        throw new JsonlLineTooLargeError('rollout line exceeds maximum size')
      }
      lines.push(this.#completeLine(tail))
      start = newline + 1
    }
    return lines
  }

  #appendPart(part: Buffer): void {
    if (part.length === 0) return
    if (this.#pendingBytes + part.length > this.#maxLineBytes) {
      throw new JsonlLineTooLargeError('rollout line exceeds maximum size')
    }
    this.#parts.push(part)
    this.#pendingBytes += part.length
  }

  #completeLine(tail: Buffer): Buffer {
    const length = this.#pendingBytes + tail.length
    const line = this.#parts.length === 0
      ? tail
      : Buffer.concat([...this.#parts, tail], length)
    this.#parts = []
    this.#pendingBytes = 0
    return line
  }
}
