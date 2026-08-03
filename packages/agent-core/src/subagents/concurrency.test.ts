import { describe, expect, it } from 'vitest'
import { createConcurrencyLimiter } from './concurrency'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createConcurrencyLimiter', () => {
  it('limits a batch while preserving input order', async () => {
    const limiter = createConcurrencyLimiter(2)
    const gates = [deferred(), deferred(), deferred()]
    const started = [deferred(), deferred(), deferred()]
    let active = 0
    let peak = 0

    const result = limiter.runAll(
      ['first', 'second', 'third'].map((value, index) => async () => {
        active += 1
        peak = Math.max(peak, active)
        started[index].resolve()
        await gates[index].promise
        active -= 1
        return value
      }),
    )

    await Promise.all(started.slice(0, 2).map((entry) => entry.promise))
    gates[0].resolve()
    await started[2].promise
    gates[1].resolve()
    gates[2].resolve()

    await expect(result).resolves.toEqual(['first', 'second', 'third'])
    expect(peak).toBe(2)
  })

  it('does not execute a queued task after cancellation', async () => {
    const limiter = createConcurrencyLimiter(1)
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = limiter.run(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
      return 'first'
    })
    await firstStarted.promise

    const controller = new AbortController()
    let queuedTaskRan = false
    const queued = limiter.run(async () => {
      queuedTaskRan = true
      return 'second'
    }, controller.signal)
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    releaseFirst.resolve()
    await expect(first).resolves.toBe('first')
    expect(queuedTaskRan).toBe(false)
  })
})
