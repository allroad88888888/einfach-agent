import { describe, expect, it } from 'vitest'
import { McpServerQueue } from './serverQueue'

/** 串行队列的三条语义：同 server 排队、跨 server 不排队、前一个失败不阻断后一个。 */

/** 排队本身要走几个微任务（`previous.catch().then(operation)`），先让它们跑完。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function deferred() {
  let resolve!: (value: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((resolveFn, rejectFn) => {
    resolve = resolveFn
    reject = rejectFn
  })
  return { promise, resolve, reject }
}

describe('McpServerQueue', () => {
  it('同一个 server 上的操作一个接一个跑', async () => {
    const queue = new McpServerQueue()
    const gate = deferred()
    const order: string[] = []

    const first = queue.serialize('remote', async () => {
      order.push('first:start')
      const value = await gate.promise
      order.push('first:end')
      return value
    })
    const second = queue.serialize('remote', async () => {
      order.push('second:start')
      return 'second'
    })

    await settle()
    // 第二个操作还没开始：它在等第一个 settle。
    expect(order).toEqual(['first:start'])

    gate.resolve('first')
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('前一个操作失败不会卡死这个 server 的队列', async () => {
    const queue = new McpServerQueue()

    const failing = queue.serialize('remote', async () => {
      throw new Error('connect refused')
    })
    const next = queue.serialize('remote', async () => 'still running')

    await expect(failing).rejects.toThrow('connect refused')
    await expect(next).resolves.toBe('still running')

    // 队尾清理正确的话，下一个操作不会被已经跑完的旧队尾挡住。
    await expect(queue.serialize('remote', async () => 'fresh')).resolves.toBe('fresh')
  })

  it('不同 server 之间互不排队', async () => {
    const queue = new McpServerQueue()
    const gate = deferred()
    const order: string[] = []

    const blocked = queue.serialize('remote', async () => {
      order.push('remote:start')
      return gate.promise
    })
    const other = queue.serialize('local', async () => {
      order.push('local:start')
      return 'local'
    })

    await expect(other).resolves.toBe('local')
    expect(order).toEqual(['remote:start', 'local:start'])

    gate.resolve('remote')
    await expect(blocked).resolves.toBe('remote')
  })
})
