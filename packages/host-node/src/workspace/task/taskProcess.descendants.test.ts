import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { spawnTask, waitForChild } from './taskProcess'
import { readWorkspaceTaskOutput } from './readWorkspaceTaskOutput'

const execFileAsync = promisify(execFile)

async function liveGroupMembers(pgid: number): Promise<string[][]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pgid=,stat='])
  return stdout.trim().split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([group, state]) => Number(group) === pgid && !state.startsWith('Z'))
}

describe.skipIf(process.platform === 'win32')('inherited task output pipes', () => {
  for (const reason of ['idle', 'total'] as const) {
    it(`retains ${reason} protection after the direct child exits`, async () => {
      const descendant = reason === 'idle'
        ? 'setInterval(() => {}, 1000)'
        : "setInterval(() => process.stdout.write('progress'), 30)"
      const child = await spawnTask({ program: process.execPath, args: ['-e', `
        const { spawn } = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
          stdio: ['ignore', 'inherit', 'inherit']
        });
        descendant.unref();
        process.exit(0);
      `] }, process.cwd())
      const started = Date.now()
      const output = readWorkspaceTaskOutput(child.stdout!, child.stderr!, 3)
      try {
        const result = await waitForChild(child, 250, 600)
        expect(result).toMatchObject({ timedOut: true, timeoutReason: reason })
        await output
        expect(Date.now() - started).toBeLessThan(2_000)
        expect(child.stdout!.closed).toBe(true)
        expect(child.stderr!.closed).toBe(true)
        // Linux may retain exited descendants as zombies until init reaps them.
        // Verify that no live member remains; signal 0 also finds those zombies.
        await expect.poll(() => liveGroupMembers(child.pid!), { timeout: 1_000 }).toEqual([])
        expect(child.listenerCount('close')).toBe(0)
      } finally {
        try { process.kill(-child.pid!, 'SIGKILL') } catch { /* group already collected */ }
      }
    })
  }

  it('allows an inherited pipe with ongoing output to finish normally', async () => {
    const child = await spawnTask({ program: process.execPath, args: ['-e', `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e',
        "const timer = setInterval(() => process.stdout.write('ok'), 30); setTimeout(() => {clearInterval(timer)}, 550)"
      ], { stdio: ['ignore', 'inherit', 'inherit'] });
      descendant.unref();
      process.exit(0);
    `] }, process.cwd())
    const output = readWorkspaceTaskOutput(child.stdout!, child.stderr!, 3)
    expect(await waitForChild(child, 250, 2_000)).toEqual({ exitCode: 0, timedOut: false })
    expect((await output).stdout.truncated).toBe(true)
  })
})
