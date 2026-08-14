import { describe, expect, it, vi } from 'vitest'
import {
  installBrowserRecoveryFlush,
  installDesktopRecoveryFlush,
  type DesktopRecoveryWindow,
} from './recoveryFlushLifecycle'

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

  it('desktop close prevents destruction until recovery writes have flushed', async () => {
    let resolveFlush: (() => void) | undefined
    const flushRecovery = vi.fn(() => new Promise<void>((resolve) => {
      resolveFlush = resolve
    }))
    let closeHandler: ((event: { preventDefault(): void }) => void | Promise<void>) | undefined
    const desktopWindow: DesktopRecoveryWindow = {
      onCloseRequested: vi.fn(async (handler) => {
        closeHandler = handler
        return vi.fn()
      }),
      destroy: vi.fn(async () => {}),
    }
    await installDesktopRecoveryFlush(recoveryOwner(flushRecovery), desktopWindow)

    const preventDefault = vi.fn()
    const closing = closeHandler?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(flushRecovery).toHaveBeenCalledTimes(1)
    expect(desktopWindow.destroy).not.toHaveBeenCalled()

    resolveFlush?.()
    await closing
    expect(desktopWindow.destroy).toHaveBeenCalledTimes(1)
  })
})
