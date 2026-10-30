import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }
describe.skipIf(process.platform === 'win32')('service host real signal', () => {
  it('SIGTERM drains a stubborn service before CLI host exit', async () => {
    const root = process.cwd()
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'apps/cli/src/serviceShutdownSignal.testHarness.ts')], {
      cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'apps/cli/tsconfig.json') }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''; let errors = ''; let code: number | null | undefined; let pid = 0
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { errors += chunk.toString() })
    child.once('exit', value => { code = value })
    try {
      for (let i = 0; i < 250 && !output.includes('READY'); i++) {
        if (code !== undefined) throw new Error(errors)
        await new Promise(r => setTimeout(r, 20))
      }
      pid = Number(output.match(/READY (\d+)/)?.[1])
      expect(pid, errors).toBeGreaterThan(0)
      child.kill('SIGTERM')
      for (let i = 0; i < 150 && code === undefined; i++) await new Promise(r => setTimeout(r, 20))
      expect(code, errors).toBe(143)
      expect(alive(pid)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
  }, 10000)
})
