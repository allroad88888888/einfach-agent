// Consume the private response of exactly one shell invocation. No replay or global subscription.
const MAX_OUTPUT_FRAME_CHARS = 2 * 1024 * 1024
const DEFAULT_REQUEST_BODY_CHARS = 32 * 1024 * 1024
export async function readShellInvokeStream<T>(
  body: ReadableStream<Uint8Array>,
  onOutput: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
  requestBodyChars = DEFAULT_REQUEST_BODY_CHARS,
): Promise<T> {
  // A final result echoes request strings. Setup errors can repeat cwd/platform in
  // diagnostics, unlike bounded pipe output. Reserve eight copies of the actual
  // serialized request plus 4 MiB for pipe escaping and metadata. The default
  // covers the server's 32 MiB body allowance; HTTP callers pass the exact size.
  const maxResultFrameChars = requestBodyChars * 8 + 4 * 1024 * 1024
  const assertFrameBound = (frame: string) => {
    const event = /^event:([^\r\n]*)/m.exec(frame)?.[1]?.trim()
    const limit = event === 'result' ? maxResultFrameChars : MAX_OUTPUT_FRAME_CHARS
    if (frame.length > limit) throw new Error('Shell stream frame exceeds limit')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  const separator = /\r?\n\r?\n/g
  let searchFrom = 0
  let outputChars = 0
  let receivedResult = false
  let result: T | undefined
  const dispatch = (frame: string) => {
    const lines = frame.split('\n')
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
    const raw = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!raw) return
    const data: unknown = JSON.parse(raw)
    if (event === 'error') {
      throw new Error(typeof data === 'object' && data && 'message' in data ? String(data.message) : 'Shell invocation failed')
    }
    if (event === 'result') { result = data as T; receivedResult = true; return }
    if (event !== 'output' || !data || typeof data !== 'object') return
    const chunk = data as Record<string, unknown>
    if ((chunk.stream !== 'stdout' && chunk.stream !== 'stderr') || typeof chunk.text !== 'string') return
    // Bound even a malformed/newer host. The host independently caps each pipe to 100k.
    const text = chunk.text.slice(0, Math.max(0, 400_000 - outputChars))
    outputChars += text.length
    if (text) onOutput({ stream: chunk.stream, text })
  }
  try {
    while (!receivedResult) {
      const next = await reader.read()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      let boundary: RegExpExecArray | null
      separator.lastIndex = searchFrom
      while ((boundary = separator.exec(pending))) {
        const frame = pending.slice(0, boundary.index)
        assertFrameBound(frame)
        pending = pending.slice(boundary.index + boundary[0].length)
        separator.lastIndex = 0
        dispatch(frame.replace(/\r\n/g, '\n'))
        if (receivedResult) break
      }
      // Only the unfinished tail belongs to one pending frame; complete frames
      // from this same network chunk have already been checked independently.
      if (!receivedResult) assertFrameBound(pending)
      searchFrom = Math.max(0, pending.length - 3)
    }
    if (!receivedResult) throw new Error('Shell stream ended before its result')
    return result as T
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
