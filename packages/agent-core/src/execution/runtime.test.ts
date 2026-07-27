import { describe, expect, it } from 'vitest'
import { createCoreInstance } from '../runtime/core/coreInstance'
import { executionGraphAtom } from './graph'
import { getExecutionRuntime } from './runtime'

describe('execution runtime lifecycle', () => {
  it('join supports a bounded wait without cancelling the execution', async () => {
    const core = createCoreInstance()
    const runtime = getExecutionRuntime(core)
    let release: (value: string) => void = () => undefined
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })
    const handle = runtime.spawn({
      sessionId: 'session',
      runId: 'run',
      label: 'slow evaluation',
      task: async () => gate,
    })

    await expect(runtime.join('session', handle.executionId, 1)).resolves.toMatchObject({
      executionId: handle.executionId,
      status: 'running',
      timedOut: true,
    })

    release('done')
    await expect(runtime.join('session', handle.executionId)).resolves.toMatchObject({
      status: 'succeeded',
      result: 'done',
    })
  })

  it('cancel is idempotent and late task success cannot overwrite cancellation', async () => {
    const core = createCoreInstance()
    const runtime = getExecutionRuntime(core)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handle = runtime.spawn({
      sessionId: 'session',
      runId: 'run',
      label: 'ignores cancellation',
      task: async () => {
        await gate
        return 'late success'
      },
    })

    expect(runtime.cancel('session', handle.executionId)).toBe(true)
    expect(runtime.cancel('session', handle.executionId)).toBe(false)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      core.getSessionStore('session').store
        .getter(executionGraphAtom).nodes[handle.executionId],
    ).toMatchObject({
      status: 'cancelled',
      error: 'cancelled',
    })
  })

  it('run cannot report success after its parent signal is cancelled', async () => {
    const core = createCoreInstance()
    const runtime = getExecutionRuntime(core)
    const controller = new AbortController()

    await expect(runtime.run({
      id: 'tool-1',
      graphId: 'run',
      sessionId: 'session',
      runId: 'run',
      type: 'tool',
      label: 'ignores parent cancellation',
      signal: controller.signal,
      task: async () => {
        controller.abort(new Error('parent stopped'))
        return 'late success'
      },
    })).rejects.toMatchObject({
      name: 'AbortError',
      message: 'parent stopped',
    })

    expect(
      core.getSessionStore('session').store
        .getter(executionGraphAtom).nodes['tool-1'],
    ).toMatchObject({
      status: 'cancelled',
      error: 'parent stopped',
    })
  })
})
