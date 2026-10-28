import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, WAIT_INTERVAL_MS } from './constants'
import { abortError, assertNotAborted } from './page-binding'
import type { DomSnapshot, PageCallContext, WaitForDomInput } from './types'

const pause = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(done, milliseconds)
  function done(): void { signal.removeEventListener('abort', cancelled); resolve() }
  function cancelled(): void { clearTimeout(timer); signal.removeEventListener('abort', cancelled); reject(abortError()) }
  signal.addEventListener('abort', cancelled, { once: true })
})

export async function waitForDom(read: () => DomSnapshot, input: WaitForDomInput, ctx: PageCallContext): Promise<DomSnapshot> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be an integer between 0 and ${MAX_TIMEOUT_MS}`)
  const condition = input.condition ?? 'present'; const deadline = Date.now() + timeoutMs
  if (condition !== 'present' && condition !== 'absent') throw new Error('condition must be present or absent')
  while (true) {
    assertNotAborted(ctx)
    const snapshot = read(); const satisfied = condition === 'present' ? snapshot.nodes.length > 0 : snapshot.nodes.length === 0
    if (satisfied) return snapshot
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`wait_for_dom timed out after ${timeoutMs}ms waiting for ${condition}`)
    await pause(Math.min(WAIT_INTERVAL_MS, remaining), ctx.signal)
  }
}
