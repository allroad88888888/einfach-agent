type RecoveryFlushOwner = {
  persistence: {
    flushRecovery(): Promise<void>
  }
}

/** Flushes already-queued recovery writes when a browser document is being discarded. */
export function installBrowserRecoveryFlush(owner: RecoveryFlushOwner): () => void {
  const flush = () => {
    void owner.persistence.flushRecovery()
  }
  window.addEventListener('pagehide', flush)
  return () => window.removeEventListener('pagehide', flush)
}
