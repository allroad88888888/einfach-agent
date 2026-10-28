// 两个上限的互动：idle 会被输出重置，total 不会
// ---------------------------------------------------------------------------
// 用 `process.execPath` 起子进程，而不是 `sleep` / `timeout`：后两个在 Windows 上不存在，
// 而本文件的断言与平台无关。也刻意不 mock ChildProcess——`waitForChild` 的全部价值就在于
// 和真实的 `'exit'` 事件、真实的信号打交道。
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createActivityPulse } from './activity'
import { waitForChild } from './wait'

/** 起一个「什么都不做、只挂着」的子进程，等被超时杀掉。 */
function hangingChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('waitForChild', () => {
  it('进程自己先退出时不报超时，也不带 timeoutReason', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const exit = await waitForChild(child, {
      idleMs: 5_000,
      totalMs: 5_000,
      pulse: createActivityPulse(),
    })

    expect(exit.exitCode).toBe(0)
    expect(exit.timedOut).toBe(false)
    // 键必须**不存在**而不是 `undefined` 以外的残值：core 侧据此决定报哪种文案。
    expect('timeoutReason' in exit).toBe(false)
  })

  it('没有任何输出时由 idle 触发，即使 total 还有充足余量', async () => {
    const child = hangingChild()

    const exit = await waitForChild(child, {
      idleMs: 120,
      totalMs: 5_000,
      pulse: createActivityPulse(),
    })

    expect(exit.timedOut).toBe(true)
    expect(exit.timeoutReason).toBe('idle')
    // 被 SIGKILL 的进程没有退出码——core 侧会整形成 exitCode: -1，那是既有语义。
    expect(exit.exitCode).toBeNull()
  })

  it('持续有输出时 idle 被不断重置，最终由 total 兜底', async () => {
    // 这是本改动的主断言：只要一直在输出，idle 就永远不该到点。
    // 20ms 喂一次，远小于 150ms 的 idle 窗口；能走到 `total` 就证明 refresh 真的生效了。
    const child = hangingChild()
    const pulse = createActivityPulse()
    const ticker = setInterval(() => pulse.touch(), 20)

    try {
      const exit = await waitForChild(child, { idleMs: 150, totalMs: 400, pulse })

      expect(exit.timedOut).toBe(true)
      expect(exit.timeoutReason).toBe('total')
    } finally {
      clearInterval(ticker)
    }
  })
})
