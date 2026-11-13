/** Bounded UTF-16 log offsets, shared across stdout/stderr. */
export class ServiceLogBuffer {
  private text = ''
  private end = 0
  append(text: string): void {
    this.end += text.length
    this.text = (this.text + text).slice(-65536)
    if (isLowSurrogate(this.text.charCodeAt(0))) this.text = this.text.slice(1)
  }
  read(cursor = 0, maxChars = 16384) {
    const baseCursor = this.end - this.text.length
    let start = Math.min(this.end, Math.max(cursor, baseCursor))
    if (isLowSurrogate(this.text.charCodeAt(start - baseCursor))) start++
    let text = this.text.slice(start - baseCursor, start - baseCursor + Math.max(2, maxChars))
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xD800 && last <= 0xDBFF) text = text.slice(0, -1)
    return { text, baseCursor, nextCursor: start + text.length, truncated: cursor < baseCursor }
  }
}

function isLowSurrogate(code: number): boolean { return code >= 0xDC00 && code <= 0xDFFF }
