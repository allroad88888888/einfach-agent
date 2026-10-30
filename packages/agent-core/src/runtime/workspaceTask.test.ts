import { afterEach, describe, expect, it } from 'vitest'
import { configureHostInvoke } from './hostBridge'
import { runWorkspaceTask } from './workspaceTask'

afterEach(() => configureHostInvoke(undefined))

describe('workspace task timeout normalization', () => {
  it.each(['idle', 'total', undefined, 'unknown'])('normalizes timeout reason %s', async (reason) => {
    configureHostInvoke({ platform: 'linux', loader: async () => async <T>() => ({
      ok: false, timedOut: true, timeoutReason: reason,
    }) as T })
    const result = await runWorkspaceTask({ kind: 'test' })
    expect(result.timedOut).toBe(true)
    expect(result.timeoutReason).toBe(reason === 'idle' || reason === 'total' ? reason : undefined)
  })

  it('drops a reason from a response that did not time out', async () => {
    configureHostInvoke({ platform: 'linux', loader: async () => async <T>() => ({
      ok: true, timedOut: false, timeoutReason: 'idle',
    }) as T })
    expect((await runWorkspaceTask({ kind: 'test' })).timeoutReason).toBeUndefined()
  })
})
