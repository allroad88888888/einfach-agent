type RecoveryFlushOwner = {
  persistence: {
    flushRecovery(): Promise<void>
  }
}

export type DesktopRecoveryWindow = {
  onCloseRequested(
    handler: (event: { preventDefault(): void }) => void | Promise<void>,
  ): Promise<() => void>
  destroy(): Promise<void>
}

/** Flushes already-queued recovery writes when a browser document is being discarded. */
export function installBrowserRecoveryFlush(owner: RecoveryFlushOwner): () => void {
  const flush = () => {
    void owner.persistence.flushRecovery()
  }
  window.addEventListener('pagehide', flush)
  return () => window.removeEventListener('pagehide', flush)
}

/** Holds a Tauri window open until its recovery queue has drained, then force-closes it. */
export function installDesktopRecoveryFlush(
  owner: RecoveryFlushOwner,
  desktopWindow: DesktopRecoveryWindow,
): Promise<() => void> {
  return desktopWindow.onCloseRequested(async (event) => {
    event.preventDefault()
    try {
      await owner.persistence.flushRecovery()
    } catch {
      // A failed recovery write must not trap the desktop window forever.
    }
    await desktopWindow.destroy()
  })
}
