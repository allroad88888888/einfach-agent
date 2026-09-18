import { describe, expect, it } from 'vitest'
import { BoundedJsonlBuffer, JsonlLineTooLargeError } from './boundedJsonlBuffer'

describe('BoundedJsonlBuffer', () => {
  it('assembles fragmented lines and preserves a partial tail', () => {
    const buffer = new BoundedJsonlBuffer(20)

    expect(buffer.append(Buffer.from('one\ntw'))).toEqual([Buffer.from('one')])
    expect(buffer.pendingBytes).toBe(2)
    expect(buffer.append(Buffer.from('o\nthree\n'))).toEqual([
      Buffer.from('two'), Buffer.from('three'),
    ])
    expect(buffer.pendingBytes).toBe(0)
  })

  it('allows a line exactly at the byte ceiling', () => {
    const buffer = new BoundedJsonlBuffer(3)
    expect(buffer.append(Buffer.from('abc\n'))).toEqual([Buffer.from('abc')])
  })

  it('rejects an oversized fragmented line before copying it', () => {
    const buffer = new BoundedJsonlBuffer(3)
    expect(buffer.append(Buffer.from('ab'))).toEqual([])
    expect(() => buffer.append(Buffer.from('cd'))).toThrow(JsonlLineTooLargeError)
  })
})
