import { describe, expect, it, vi } from 'vitest'
import { createHttpInvoke } from './serverInvoke'

describe('HTTP shell stream negotiation', () => {
  it('requests private SSE and forwards incremental data with the same abort signal', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => new Response(
      'event: output\ndata: {"stream":"stderr","text":"live"}\n\nevent: result\ndata: {"exit_code":0}\n\n',
      { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
    ))
    const invoke = createHttpInvoke({ fetch })
    const output = vi.fn()
    expect(await invoke('run_shell_command', {}, { signal: controller.signal, onShellOutput: output })).toEqual({ exit_code: 0 })
    const init = (fetch.mock.calls as unknown as [string, { headers: Record<string, string>; signal: AbortSignal }][])[0][1]
    expect(init.headers.accept).toBe('text/event-stream')
    expect(init.signal).toBe(controller.signal)
    expect(output).toHaveBeenCalledWith({ stream: 'stderr', text: 'live' })
  })
  it('accepts the JSON final result of an older host without promising live output', async () => {
    const fetch = vi.fn(async () => new Response('{"exit_code":0,"stdout":"final"}', { headers: { 'content-type': 'application/json' } }))
    const output = vi.fn()
    expect(await createHttpInvoke({ fetch })('run_shell_command', {}, { onShellOutput: output })).toEqual({ exit_code: 0, stdout: 'final' })
    expect(output).not.toHaveBeenCalled()
  })
  it('propagates an SSE error using the existing HostInvoke rejection shape', async () => {
    const fetch = vi.fn(async () => new Response('event: error\ndata: {"message":"denied"}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    await expect(createHttpInvoke({ fetch })('run_shell_command', {}, { onShellOutput: vi.fn() })).rejects.toContain('denied')
  })
})
