import type { HistoryLogDriver } from '@einfach-agent/core/state/persistence'
import type { HostInvoke } from '@einfach-agent/core'
import { httpInvoke } from '../host/serverInvoke'

/** Sends only new journal batches to the local host; recovery uses a small immutable head reference. */
export function createServerHistoryLogDriver(invoke: HostInvoke = httpInvoke): HistoryLogDriver {
  return {
    async append(sessionId, batch) { await invoke('session_history_append', { sessionId, batch }) },
    load(sessionId, head) { return invoke('session_history_load', { sessionId, head }) },
  }
}
