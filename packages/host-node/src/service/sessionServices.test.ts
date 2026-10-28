import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionServices } from './sessionServices'
import { ServiceLogBuffer } from './logBuffer'

const managers: SessionServices[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.dispose())) })
function manager() { const m = new SessionServices(); managers.push(m); return m }
const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)) }
  throw new Error('condition timed out')
}

describe.skipIf(process.platform === 'win32')('session services real processes', () => {
  it('starts, incrementally reads UTF-8 logs, isolates owners and actively stops', async () => {
    const m = manager()
    const service = await m.start('a', node("console.log('你好');setInterval(()=>console.log('tick'),30)"))
    await until(() => m.logs('a', service.serviceId, 0, 1000).text.includes('你好'))
    const first = m.logs('a', service.serviceId, 0, 1000)
    expect(first.text).toContain('你好')
    await until(() => m.logs('a', service.serviceId, first.nextCursor, 1000).text.includes('tick'))
    expect(() => m.status('b', service.serviceId)).toThrow('Unknown service')
    expect(() => m.logs('b', service.serviceId, 0, 10)).toThrow('Unknown service')
    await expect(m.stop('b', service.serviceId)).rejects.toThrow('Unknown service')
    expect((await m.stop('a', service.serviceId)).state).toBe('stopped')
  })
  it.each([0, 7])('retains final exit result %s', async code => {
    const m = manager()
    const service = await m.start('a', node(`console.log('done');process.exit(${code})`))
    await until(() => m.status('a', service.serviceId).exitCode === code)
    expect(m.status('a', service.serviceId).state).toBe(code ? 'failed' : 'exited')
    expect(m.logs('a', service.serviceId, 0, 1000).text).toContain('done')
  })
  it('cleans session deletion, rejects delayed starts, and host disposal blocks starts', async () => {
    const m = manager()
    const service = await m.start('a', node('setInterval(()=>{},1000)'))
    await m.end('a')
    expect(() => m.status('a', service.serviceId)).toThrow('Unknown service')
    await expect(m.start('a', 'true')).rejects.toThrow('closed')
    await m.dispose()
    await expect(m.start('b', 'true')).rejects.toThrow('closed')
  })
  it('does not spawn after end/dispose during asynchronous setup', async () => {
    const m = manager()
    const pending = m.start('a', node('setInterval(()=>{},1000)'))
    const rejection = expect(pending).rejects.toThrow('closed')
    await m.end('a'); await rejection
    const pending2 = m.start('b', node('setInterval(()=>{},1000)'))
    const rejection2 = expect(pending2).rejects.toThrow('closed')
    await m.dispose(); await rejection2
  })
  it('rolls back aborted startup and failed cwd without consuming capacity', async () => {
    const m = manager()
    const controller = new AbortController()
    const pending = m.start('a', node('setInterval(()=>{},1000)'), undefined, undefined, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect(m.start('a', 'true', '/nonexistent/session-service')).rejects.toThrow()
    expect((await m.start('a', 'true')).serviceId).toBeTruthy()
  })
  it('bounds flood logs and active session capacity', async () => {
    const m = manager()
    const service = await m.start('a', node("process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000)"))
    await until(() => m.logs('a', service.serviceId, 0, 65536).truncated)
    const logs = m.logs('a', service.serviceId, 0, 65536)
    expect(logs.text.length).toBeLessThanOrEqual(65536)
    expect(logs.baseCursor).toBeGreaterThan(0)
    await Promise.all(Array.from({length: 7}, () => m.start('a', node('setInterval(()=>{},1000)'))))
    await expect(m.start('a', 'true')).rejects.toThrow('capacity')
  })
})
it('log buffer preserves offsets under truncation', () => {
  const logs = new ServiceLogBuffer(); logs.append('a'.repeat(70000))
  expect(logs.read(0, 12)).toEqual({ text: 'a'.repeat(12), baseCursor: 4464, nextCursor: 4476, truncated: true })
})
it('rejects Windows services explicitly', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try { await expect(manager().start('a', 'anything')).rejects.toThrow('unsupported on Windows') }
  finally { platform.mockRestore() }
})
