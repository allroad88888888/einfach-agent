import { hasHostBridge, loadHostInvoke } from './hostBridge'

/** Capture the current host before awaiting, so cleanup cannot migrate to a replacement host. */
export async function endSessionServices(sessionId: string): Promise<void> {
  if (!hasHostBridge()) return
  const pending = loadHostInvoke()
  const invoke = await pending
  await invoke('end_service_session', { sessionId })
}
