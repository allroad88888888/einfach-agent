import { describe, expect, it } from 'vitest'
import { spawnTask, waitForChild } from './taskProcess'

const cwd = process.cwd()

describe('spawnTask', () => {
  it('程序存在时 resolve 一个已经 spawn 成功的子进程', async () => {
    const child = await spawnTask({ program: 'node', args: ['-e', 'process.exit(0)'] }, cwd)
    expect(typeof child.pid).toBe('number')
    await waitForChild(child, 5_000)
  })

  it('程序不存在时 reject，消息带上程序名', async () => {
    await expect(
      spawnTask({ program: 'no-such-binary-xyz-123', args: [] }, cwd),
    ).rejects.toThrow(/failed to spawn `no-such-binary-xyz-123`/)
  })
})

describe('waitForChild', () => {
  it('正常退出：exitCode 透传、timedOut 为 false', async () => {
    const child = await spawnTask({ program: 'node', args: ['-e', 'process.exit(7)'] }, cwd)
    await expect(waitForChild(child, 5_000)).resolves.toEqual({ exitCode: 7, timedOut: false })
  })

  it('0 退出码同样正常透传（不是「没有 code」的特殊值）', async () => {
    const child = await spawnTask({ program: 'node', args: ['-e', 'process.exit(0)'] }, cwd)
    await expect(waitForChild(child, 5_000)).resolves.toEqual({ exitCode: 0, timedOut: false })
  })

  it('超时会杀掉子进程：不必等它自然结束，exitCode 标成 -1、timedOut 为 true', async () => {
    const started = Date.now()
    const child = await spawnTask(
      { program: 'node', args: ['-e', 'setTimeout(() => {}, 10_000)'] },
      cwd,
    )

    const result = await waitForChild(child, 150)

    expect(result).toEqual({ exitCode: -1, timedOut: true })
    // 真正被杀掉了，不是傻等 10s 的 setTimeout 自然到期——上限给够余量防抖但仍远小于 10s。
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('超时杀的是整个进程组：子进程派生的孙进程也会被收掉', async () => {
    // 父进程 fork 一个孙进程，孙进程活得比超时窗口久很多；只有杀整个进程组才能连它一起收。
    // 用一个标记文件证明：若孙进程存活到超时之后，它会在退出前写文件；杀group 应该让它来不及写。
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const markerDir = await mkdtemp(join(tmpdir(), 'host-node-task-group-kill-'))
    const markerPath = join(markerDir, 'marker.txt')
    try {
      const script = `
        const { spawn } = require('node:child_process');
        spawn('node', ['-e', 'setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "done"), 800)'], { stdio: 'ignore' });
        setTimeout(() => {}, 10000);
      `
      const child = await spawnTask({ program: 'node', args: ['-e', script] }, cwd)

      await waitForChild(child, 150)
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      await expect(readFile(markerPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })
})
