import type { ChildProcess } from 'node:child_process'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { drainOutputReaders } from './drain'
import { captureOutput } from './outputCapture'

/**
 * 假的直接子进程：drain 只用它做 `killChild`。`pid` 给 undefined 让 killChild 跳过进程组
 * 那一步（测试进程自己的进程组可杀不得），只记一次「杀过了」。
 */
function stubChild(): { child: ChildProcess; kills: () => number } {
  let kills = 0
  const child = {
    pid: undefined,
    kill: () => {
      kills += 1
      return true
    },
  }
  return { child: child as unknown as ChildProcess, kills: () => kills }
}

/** 永远不结束的流：模拟被后台孙进程握着写端的管道。 */
function stalledStream(initial: string): Readable {
  const source = new Readable({ read() {} })
  source.push(Buffer.from(initial))
  return source
}

describe('drainOutputReaders', () => {
  it('两条流都读完了：不杀进程，也不报告清理后台进程', async () => {
    const { child, kills } = stubChild()
    const captures = [
      captureOutput(Readable.from([Buffer.from('out')]), 'stdout', 100),
      captureOutput(Readable.from([Buffer.from('err')]), 'stderr', 100),
    ]

    await expect(drainOutputReaders(child, captures)).resolves.toBe(false)
    expect(kills()).toBe(0)
  })

  it('grace 到点仍读不完：杀进程组、放弃读取、保留已捕获的部分', async () => {
    // 这是 `cmd &` 的孤儿场景在单元层的最小复现：写端永远不关，无条件等下去就是永久挂起。
    const { child, kills } = stubChild()
    const stalled = stalledStream('half-written')
    const captures = [
      captureOutput(stalled, 'stdout', 100),
      captureOutput(Readable.from([Buffer.from('err')]), 'stderr', 100),
    ]

    await expect(drainOutputReaders(child, captures)).resolves.toBe(true)

    expect(kills()).toBe(1)
    expect(captures[0]?.take()).toEqual({ text: 'half-written', truncated: false })
    // 放弃 = 真的把流关掉。留着它，fd 和 event loop handle 会一直挂着，CLI 宿主退不出去。
    expect(stalled.destroyed).toBe(true)
  }, 5_000)

  it('读管道失败是桥调用失败，不是一次退出码 1 的结果', async () => {
    const { child } = stubChild()
    const broken = new Readable({
      read() {
        this.destroy(new Error('pipe exploded'))
      },
    })

    await expect(
      drainOutputReaders(child, [captureOutput(broken, 'stdout', 100)]),
    ).rejects.toThrow('failed to read child stdout: pipe exploded')
  })
})
