// A shell stream is private to its POST response; never publish output on the host bus.
import type { ServerResponse } from 'node:http'

export function openShellInvokeStream(response: ServerResponse, abort: () => void) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  response.write(': connected\n\n')
  const send = (event: string, data: unknown) => {
    if (response.destroyed || response.writableEnded) return
    // Disconnect slow consumers instead of accumulating unbounded socket buffers.
    if (response.writableLength > 256 * 1024) {
      abort()
      response.destroy()
      return
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  return {
    output: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => send('output', chunk),
    finish: (event: 'result' | 'error', data: unknown) => {
      send(event, data)
      response.end()
    },
  }
}
