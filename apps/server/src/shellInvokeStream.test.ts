import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { executeShellCommand } from '../../../packages/host-node/src/shell/pipeline'
import { currentPlatform } from '../../../packages/host-node/src/shell/platform'
import { readShellInvokeStream } from '../../web/src/host/readShellInvokeStream'
import { startTestServer, type TestServerHandle } from './testServer.testHarness'
import { startInvokeRouteTestServer } from './invokeRoute.testHarness'

const token = 'stream-test-token'
let server: TestServerHandle | undefined
const requests: ReturnType<typeof httpRequest>[] = []
afterEach(async () => {
  for (const request of requests.splice(0)) request.destroy()
  await server?.close()
  server = undefined
})
async function request(path: string, body?: Record<string, unknown>, authorized = true) {
  const req = httpRequest({ host: '127.0.0.1', port: server!.port, path, agent: false,
    method: body ? 'POST' : 'GET', headers: {
      accept: 'text/event-stream', 'content-type': 'application/json',
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
    } })
  requests.push(req)
  req.end(body ? JSON.stringify(body) : undefined)
  return (await once(req, 'response'))[0] as IncomingMessage
}
function webBody(response: IncomingMessage) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on('data', (bytes: Buffer) => controller.enqueue(new Uint8Array(bytes)))
      response.on('end', () => controller.close())
      response.on('error', (error) => controller.error(error))
    },
    cancel() { response.destroy() },
  })
}
const args = (command: string) => ({ platform: currentPlatform(), command })

describe.skipIf(process.platform === 'win32')('private POST shell SSE', () => {
  it('streams real children before completion, isolates another call and the global subscriber', async () => {
    server = await startTestServer({ token })
    const global = await request('/api/events')
    let globalText = ''
    global.on('data', (chunk) => { globalText += String(chunk) })
    const denied = await request('/api/invoke/run_shell_command', args('printf secret'), false)
    expect(denied.statusCode).toBe(401)
    denied.resume()
    let done = false
    const outA: string[] = [], outB: string[] = []
    const a = await request('/api/invoke/run_shell_command', args('printf private-a; sleep 0.3; printf err-a >&2'))
    expect(a.headers['cache-control']).toBe('no-store')
    const first = readShellInvokeStream<Record<string, unknown>>(webBody(a), (chunk) => {
      expect(done).toBe(false)
      outA.push(chunk.text)
    }).then((result) => { done = true; return result })
    const b = await request('/api/invoke/run_shell_command', args('printf private-b'))
    const second = readShellInvokeStream<Record<string, unknown>>(webBody(b), (chunk) => outB.push(chunk.text))
    expect((await first).exit_code).toBe(0)
    expect((await second).exit_code).toBe(0)
    expect(outA.join('')).toBe('private-aerr-a')
    expect(outB.join('')).toBe('private-b')
    expect(globalText).not.toMatch(/private-|err-a|secret/)
    global.destroy()
  }, 20_000)

  it('aborts a real child when its response disconnects', async () => {
    let aborted = false
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => { finish = resolve })
    server = await startInvokeRouteTestServer({ invoke: async <T>(_cmd: string, _args?: Record<string, unknown>, options?: { signal?: AbortSignal; onShellOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void }) => {
      try {
        return await executeShellCommand({ platform: currentPlatform(), command: 'printf ready; sleep 20' }, options?.signal, options?.onShellOutput) as T
      } catch (error) { aborted = options?.signal?.aborted ?? false; throw error }
      finally { finish() }
    } })
    const response = await request('/api/invoke/run_shell_command', args('ignored'))
    await new Promise<void>((resolve) => {
      response.on('data', (chunk) => {
        if (String(chunk).includes('ready')) { response.destroy(); resolve() }
      })
    })
    await finished
    expect(aborted).toBe(true)
  }, 20_000)

  it('delivers a structured error after SSE headers, rather than hanging', async () => {
    server = await startInvokeRouteTestServer({ invoke: async () => { throw new Error('expected shell failure') } })
    const response = await request('/api/invoke/run_shell_command', args('ignored'))
    await expect(readShellInvokeStream(webBody(response), () => {})).rejects.toThrow('expected shell failure')
  })
  it('delivers a valid large failed result with escaped command echo', async () => {
    server = await startTestServer({ token })
    const command = '\u0001'.repeat(360_000)
    const response = await request('/api/invoke/run_shell_command', { command, platform: 'unsupported' })
    const result = await readShellInvokeStream<Record<string, unknown>>(webBody(response), () => {}, JSON.stringify({ command, platform: 'unsupported' }).length)
    expect(result.command).toBe(command)
    expect(result.exit_code).toBe(1)
    expect(result.stderr).toContain('unsupported platform')
  })

})
