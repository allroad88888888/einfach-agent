import { afterEach, describe, expect, it } from 'vitest'
import { SessionServices } from './sessionServices'

const m = new SessionServices()
afterEach(async () => m.dispose())
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }
describe.skipIf(process.platform === 'win32')('service process groups', () => {
  it('kills descendants on stop even if the leader has already exited', async () => {
    const code = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(child.pid);setTimeout(()=>process.exit(0),100)`
    const service = await m.start('descendants', `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`)
    let pid = 0
    for (let i = 0; i < 100; i++) {
      pid = Number(m.logs('descendants', service.serviceId, 0, 100).text.trim())
      if (pid) break
      await new Promise(r => setTimeout(r, 10))
    }
    expect(pid).toBeGreaterThan(0)
    for (let i = 0; i < 100 && m.status('descendants', service.serviceId).exitCode === null; i++) await new Promise(r => setTimeout(r, 10))
    expect(m.status('descendants', service.serviceId).exitCode).toBe(0)
    await m.stop('descendants', service.serviceId)
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise(r => setTimeout(r, 10))
    expect(alive(pid)).toBe(false)
  })
})
