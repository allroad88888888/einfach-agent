import { describe, expect, it, vi } from 'vitest'
import { installBrowserRecoveryFlush } from './recoveryFlushLifecycle'

function recoveryOwner(flushRecovery = vi.fn(async () => {})) {
  return { persistence: { flushRecovery } }
}

describe('recovery flush lifecycle', () => {
  it('browser pagehide starts a non-blocking recovery flush', () => {
    const flushRecovery = vi.fn(async () => {})
    const remove = installBrowserRecoveryFlush(recoveryOwner(flushRecovery))

    window.dispatchEvent(new Event('pagehide'))
    expect(flushRecovery).toHaveBeenCalledTimes(1)

    remove()
    window.dispatchEvent(new Event('pagehide'))
    expect(flushRecovery).toHaveBeenCalledTimes(1)
  })
})
