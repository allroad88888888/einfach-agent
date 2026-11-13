import { describe, expect, it, vi } from 'vitest'
import { readShellInvokeStream } from './readShellInvokeStream'

function stream(text: string) {
  const bytes = new TextEncoder().encode(text)
  const cancel = vi.fn()
  return { cancel, body: new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() },
    cancel,
  }) }
}

describe('private SSE consumer', () => {
  it('handles byte boundaries, CRLF, multiline content and Unicode', async () => {
    const source = stream('event: output\r\ndata: {"stream":"stdout","text":"中😀\\nline"}\r\n\r\nevent: result\r\ndata: {"exit_code":0}\r\n\r\n')
    const output = vi.fn()
    expect(await readShellInvokeStream(source.body, output)).toEqual({ exit_code: 0 })
    expect(output).toHaveBeenCalledWith({ stream: 'stdout', text: '中😀\nline' })
    expect(source.body.locked).toBe(false)
  })
  it('rejects errors or an interrupted response and releases its reader', async () => {
    for (const text of ['event: error\ndata: {"message":"denied"}\n\n', ': connected\n\n']) {
      const source = stream(text)
      await expect(readShellInvokeStream(source.body, vi.fn())).rejects.toThrow()
      expect(source.body.locked).toBe(false)
    }
  })
  it('bounds a malformed frame', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
    } })
    await expect(readShellInvokeStream(body, vi.fn())).rejects.toThrow('limit')
    expect(body.locked).toBe(false)
  })
  it('accepts a legal escaped request echo larger than the output-frame cap', async () => {
    const command = '\u0001'.repeat(900_000)
    const value = { command, platform: 'unsupported', exit_code: 1 }
    const wire = `event: result\ndata: ${JSON.stringify(value)}\n\n`
    expect(wire.length).toBeGreaterThan(4 * 1024 * 1024)
    const bytes = new TextEncoder().encode(wire)
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      // Split the event header and payload across reads, like a real response.
      controller.enqueue(bytes.slice(0, 8))
      controller.enqueue(bytes.slice(8, 2 * 1024 * 1024))
      controller.enqueue(bytes.slice(2 * 1024 * 1024))
      controller.close()
    } })
    expect(await readShellInvokeStream(body, vi.fn(), JSON.stringify({ command }).length)).toEqual(value)
  })

  it('checks independent frames rather than the size of their shared network chunk', async () => {
    const frame = `event: output\ndata: ${JSON.stringify({ stream: 'stdout', text: 'x'.repeat(700_000) })}\n\n`
    const wire = frame.repeat(4) + 'event: result\ndata: {"exit_code":0}\n\n'
    expect(wire.length).toBeGreaterThan(2 * 1024 * 1024)
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(wire)); controller.close()
    } })
    const output = vi.fn()
    expect(await readShellInvokeStream(body, output)).toEqual({ exit_code: 0 })
    expect(output.mock.calls.reduce((total, [chunk]) => total + chunk.text.length, 0)).toBe(400_000)
  })

  it('still bounds oversized complete output and final-result frames', async () => {
    for (const wire of [
      `event: output\ndata: ${JSON.stringify({ stream: 'stdout', text: 'x'.repeat(2 * 1024 * 1024) })}\n\n`,
      `event: result\ndata: ${JSON.stringify({ command: 'x'.repeat(4 * 1024 * 1024 + 1) })}\n\n`,
    ]) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(wire)); controller.close()
      } })
      await expect(readShellInvokeStream(body, vi.fn(), 0)).rejects.toThrow('limit')
      expect(body.locked).toBe(false)
    }
  })

})
