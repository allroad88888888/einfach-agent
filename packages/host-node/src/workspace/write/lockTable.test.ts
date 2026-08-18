import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { PATH_LOCK_SWEEP_THRESHOLD } from './limits'
import { createPathLockTable, withPathLock } from './lockTable'

/**
 * 一段「像写入流水线」的临界区：进去、跨两次 await、出来。
 *
 * 两次 await 不是装饰——它们就是 `read before` 和 `atomicWrite` 之间那两个让出点，也是这把锁
 * 存在的唯一理由。临界区里观测共享计数器：`peak > 1` 就说明两次调用**同时**在里面。
 * 只断言最终结果正确是不够的，那可能只是碰巧谁后写谁赢。
 */
interface Observer {
  active: number
  peak: number
  trace: string[]
}

function createObserver(): Observer {
  return { active: 0, peak: 0, trace: [] }
}

function criticalSection(observer: Observer, name: string): () => Promise<string> {
  return async () => {
    observer.active += 1
    observer.peak = Math.max(observer.peak, observer.active)
    observer.trace.push(`${name}:enter`)
    await delay(5) // 读 before
    await delay(5) // 写文件
    observer.trace.push(`${name}:exit`)
    observer.active -= 1
    return name
  }
}

describe('withPathLock —— 同一路径的并发写被串行化', () => {
  it('对照组：不上锁时这段临界区确实会交错（证明本文件的断言拦得住退化）', async () => {
    // 没有这一条，「加锁后 peak===1」可能只是因为临界区根本不让出，断言就成了摆设。
    const observer = createObserver()
    await Promise.all([criticalSection(observer, 'A')(), criticalSection(observer, 'B')()])
    expect(observer.peak).toBe(2)
    // 两个 enter 都在任何 exit 之前——B 是在 A 还没写完的时候进来的，正是那次「覆盖」的形状。
    expect(observer.trace.slice(0, 2)).toEqual(['A:enter', 'B:enter'])
  })

  it('两个并发写同一路径：临界区任何时刻只有一个，先来先跑完', async () => {
    const table = createPathLockTable()
    const observer = createObserver()
    const target = '/ws/notes.jsonl'
    await Promise.all([
      table.run(target, criticalSection(observer, 'A')),
      table.run(target, criticalSection(observer, 'B')),
    ])
    expect(observer.peak).toBe(1)
    expect(observer.trace).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit'])
  })

  it('十个并发写同一路径：全部串行，返回值按入队顺序', async () => {
    const table = createPathLockTable()
    const observer = createObserver()
    const target = '/ws/notes.jsonl'
    const names = Array.from({ length: 10 }, (_, index) => `w${index}`)
    const results = await Promise.all(
      names.map((name) => table.run(target, criticalSection(observer, name))),
    )
    expect(observer.peak).toBe(1)
    expect(results).toEqual(names)
    expect(observer.trace).toEqual(names.flatMap((name) => [`${name}:enter`, `${name}:exit`]))
  })

  it('模块级的那把锁（流水线实际用的入口）同样串行化', async () => {
    // createPathLockTable 串行不等于 withPathLock 串行：后者多一层模块级单例，接错了照样并发。
    const observer = createObserver()
    const target = `/ws/module-level-${process.hrtime.bigint()}.jsonl`
    await Promise.all([
      withPathLock(target, criticalSection(observer, 'A')),
      withPathLock(target, criticalSection(observer, 'B')),
    ])
    expect(observer.peak).toBe(1)
  })

  it('不同路径互不阻塞——锁是按路径分桶的，不是一条全局队列', async () => {
    // 退化成「一条全局队列」时上面几条依然全绿（串行化只会更强），只有这一条会红。
    const table = createPathLockTable()
    const observer = createObserver()
    await Promise.all([
      table.run('/ws/a.txt', criticalSection(observer, 'A')),
      table.run('/ws/b.txt', criticalSection(observer, 'B')),
    ])
    expect(observer.peak).toBe(2)
  })

  it('临界区抛错不会卡死后面排队的写', async () => {
    const table = createPathLockTable()
    const target = '/ws/notes.jsonl'
    const failing = table.run(target, () => Promise.reject(new Error('boom')))
    // 在失败者 settle **之前**就排进去，走的正是 `tail.then(op, op)` 的 rejected 分支。
    const queued = table.run(target, async () => 'after')
    await expect(failing).rejects.toThrow('boom')
    await expect(queued).resolves.toBe('after')
  })
})

describe('锁表的扫除', () => {
  it('超过阈值时清掉无人持有的条目——路径无界，不清就是内存泄漏', async () => {
    const table = createPathLockTable()
    for (let index = 0; index <= PATH_LOCK_SWEEP_THRESHOLD; index += 1) {
      await table.run(`/ws/file-${index}.txt`, async () => undefined)
    }
    expect(table.size).toBe(PATH_LOCK_SWEEP_THRESHOLD + 1)
    await table.run('/ws/trigger.txt', async () => undefined)
    expect(table.size).toBe(1)
  })

  it('阈值以内不扫，条目留着（扫除是摊还的，不是每次都做）', async () => {
    const table = createPathLockTable()
    await table.run('/ws/a.txt', async () => undefined)
    await table.run('/ws/b.txt', async () => undefined)
    expect(table.size).toBe(2)
  })

  it('扫除不碰还有人持有的条目：被持有的路径在扫除之后仍然互斥', async () => {
    // 这条钉的是扫除的**判据**。若判据退化成「表满就整张清空」，被持有的那条会被删掉，
    // 后来者新建一条空队列、立刻进入临界区——而持有者还在里面。
    const table = createPathLockTable()
    let finishHolder = (): void => {}
    const holder = table.run(
      '/ws/held.txt',
      () =>
        new Promise<void>((resolve) => {
          finishHolder = resolve
        }),
    )
    for (let index = 0; index <= PATH_LOCK_SWEEP_THRESHOLD; index += 1) {
      await table.run(`/ws/file-${index}.txt`, async () => undefined)
    }
    await table.run('/ws/trigger.txt', async () => undefined)

    let queuedStarted = false
    const queued = table.run('/ws/held.txt', async () => {
      queuedStarted = true
    })
    await delay(10)
    expect(queuedStarted).toBe(false)

    finishHolder()
    await Promise.all([holder, queued])
    expect(queuedStarted).toBe(true)
  })
})
