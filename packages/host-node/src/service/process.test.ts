import { describe, expect, it } from 'vitest'
import { launchService } from './process'
import { ServiceLogBuffer } from './logBuffer'

describe.skipIf(process.platform === 'win32')('service process failures and decoding', () => {
  it('rejects spawn failure without leaving an unhandled process error', async () => {
    const process = launchService('/nonexistent/service-program', [], '/', undefined, new ServiceLogBuffer())
    await expect(process.ready).rejects.toThrow()
    await process.stop()
  })
  it('decodes UTF-8 split across writes and drains both streams', async () => {
    const logs = new ServiceLogBuffer()
    const child = launchService(process.execPath, ['-e', "process.stdout.write(Buffer.from([0xe4,0xbd]));setTimeout(()=>{process.stdout.write(Buffer.from([0xa0]));console.error('error');},30);setTimeout(()=>{},200)"], process.cwd(), undefined, logs)
    try {
      await child.ready
      for (let i = 0; i < 100 && !logs.read().text.includes('error'); i++) await new Promise(r => setTimeout(r, 10))
      expect(logs.read().text).toContain('你')
      expect(logs.read().text).toContain('error')
      expect(logs.read().text).not.toContain('�')
    } finally { await child.stop() }
  })
})
it('bounds logs without slicing a retained surrogate pair', () => {
  const logs = new ServiceLogBuffer(); logs.append('😀' + 'a'.repeat(65535))
  expect(logs.read(0, 65536).text).toBe('a'.repeat(65535))
})
