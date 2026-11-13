import { describe, expect, it } from 'vitest'
import { spawnTask, waitForChild } from './taskProcess'
import { readWorkspaceTaskOutput } from './readWorkspaceTaskOutput'

describe('task output activity deadlines', () => {
  for (const stream of ['stdout', 'stderr']) {
    it(`${stream} keeps the task alive past idle even after capture is capped`, async () => {
      const child = await spawnTask({ program: process.execPath, args: ['-e', `
        const timer = setInterval(() => process.${stream}.write('abcdefghij'), 30);
        setTimeout(() => { clearInterval(timer); process.exit(0) }, 550);
      `] }, process.cwd())
      const output = readWorkspaceTaskOutput(child.stdout!, child.stderr!, 3)
      const result = await waitForChild(child, 250, 2_000)
      expect(result).toEqual({ exitCode: 0, timedOut: false })
      const captured = await output
      expect(captured[stream as 'stdout' | 'stderr']).toEqual({ text: 'abc', truncated: true })
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.stdout!.listenerCount('data')).toBe(0)
      expect(child.stderr!.listenerCount('data')).toBe(0)
    })
  }

  it('continuous output still reaches the independent total deadline', async () => {
    const child = await spawnTask({ program: process.execPath, args: ['-e',
      "setInterval(() => process.stdout.write('progress'), 30)",
    ] }, process.cwd())
    const output = readWorkspaceTaskOutput(child.stdout!, child.stderr!, 2)
    expect(await waitForChild(child, 250, 550)).toEqual({
      exitCode: -1, timedOut: true, timeoutReason: 'total',
    })
    expect((await output).stdout).toEqual({ text: 'pr', truncated: true })
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('a poll error releases timers and activity listeners', async () => {
    const child = await spawnTask({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, process.cwd())
    const result = waitForChild(child, 250, 550)
    child.emit('error', new Error('poll failed'))
    await expect(result).rejects.toThrow('poll failed')
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.stdout!.listenerCount('data')).toBe(0)
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  })
})
