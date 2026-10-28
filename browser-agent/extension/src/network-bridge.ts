import type { CaptureInput, CaptureStatus, NetworkCallContext, NetworkCaptureOptions, NetworkListInput, NetworkListResult, NetworkRequestDetails, NetworkRequestSummary, NetworkResponseDetails, NetworkToolsHost, NetworkWaitInput, RequestInput } from '@einfach-agent/tools-browser-network'
import type { ExtensionPageBridge } from './page-bridge'
import { CHANNEL, type ExtensionResponse, type NetworkMethod } from './protocol'

export class ExtensionNetworkBridge implements NetworkToolsHost {
  private readonly captures = new Map<string, Set<string>>()
  constructor(private readonly pages: Pick<ExtensionPageBridge, 'target'>) {}

  async startCapture(input: NetworkCaptureOptions, ctx: NetworkCallContext): Promise<CaptureStatus> {
    const result = await this.call('startCapture', input, ctx) as CaptureStatus
    let owned = this.captures.get(ctx.sessionId)
    if (!owned) { owned = new Set(); this.captures.set(ctx.sessionId, owned) }
    owned.add(result.captureId)
    return result
  }
  async stopCapture(input: CaptureInput, ctx: NetworkCallContext): Promise<CaptureStatus> {
    const result = await this.call('stopCapture', input, ctx) as CaptureStatus
    this.captures.get(ctx.sessionId)?.delete(input.captureId)
    return result
  }
  listRequests(input: NetworkListInput, ctx: NetworkCallContext): Promise<NetworkListResult> { return this.call('listRequests', input, ctx) as Promise<NetworkListResult> }
  getRequest(input: RequestInput, ctx: NetworkCallContext): Promise<NetworkRequestDetails> { return this.call('getRequest', input, ctx) as Promise<NetworkRequestDetails> }
  getResponse(input: RequestInput, ctx: NetworkCallContext): Promise<NetworkResponseDetails> { return this.call('getResponse', input, ctx) as Promise<NetworkResponseDetails> }
  waitForRequest(input: NetworkWaitInput, ctx: NetworkCallContext): Promise<NetworkRequestSummary> { return this.call('waitForRequest', input, ctx) as Promise<NetworkRequestSummary> }

  async dispose(): Promise<void> {
    const calls: Promise<unknown>[] = []
    for (const [sessionId, captureIds] of this.captures) for (const captureId of captureIds) {
      const controller = new AbortController()
      calls.push(this.call('stopCapture', { captureId }, { sessionId, signal: controller.signal }).catch(() => undefined))
    }
    this.captures.clear()
    await Promise.all(calls)
  }

  private call(method: NetworkMethod, input: unknown, ctx: NetworkCallContext): Promise<unknown> {
    const target = this.pages.target(ctx.sessionId)
    if (!target) return Promise.reject(new Error('This session is not bound to a page. Bind a target before using network tools.'))
    if (ctx.signal.aborted) return Promise.reject(abortError())
    const requestId = crypto.randomUUID()
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = () => {
      rejectAbort(abortError())
      void chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'cancel-network-call', requestId, target, sessionId: ctx.sessionId }).catch(() => undefined)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const request = chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'network-call', requestId, target, sessionId: ctx.sessionId, method, input })
      .then((value) => {
        const response = value as ExtensionResponse
        if (!response?.ok) throw new Error(response?.error ?? 'Network call failed.')
        return response.data
      })
    return Promise.race([request, aborted]).finally(() => ctx.signal.removeEventListener('abort', onAbort))
  }
}

function abortError(): DOMException { return new DOMException('The network call was cancelled.', 'AbortError') }
