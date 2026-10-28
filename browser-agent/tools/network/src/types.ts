import type { ToolContext } from '@einfach-agent/core/tools'

export type NetworkCallContext = Pick<ToolContext, 'sessionId' | 'signal'>
export interface CaptureRef { captureId: string; targetId: string; documentId: string }
export interface CaptureStatus extends CaptureRef {
  active: boolean
  startedAt: number
  recordingStartedAt: number
  scope: 'document' | 'capture'
  stoppedAt?: number
  count: number
  droppedCount: number
}
export interface NetworkCaptureOptions { urlIncludes?: string; methods?: readonly string[]; includeBuffered?: boolean }
export interface CaptureInput { captureId: string }
export interface RequestInput extends CaptureInput { requestId: string }
export interface NetworkListInput { captureId?: string; offset?: number; limit?: number; urlIncludes?: string; method?: string }
export interface NetworkWaitInput extends CaptureInput { urlIncludes?: string; method?: string; state?: 'started' | 'finished'; timeoutMs?: number }
export interface NetworkRequestSummary { requestId: string; url: string; method: string; resourceType: 'fetch' | 'xhr'; state: 'pending' | 'complete' | 'error'; startedAt: number; durationMs?: number; status?: number }
export interface NetworkRequestDetails extends NetworkRequestSummary { requestHeaders: Readonly<Record<string, string>>; requestBody?: string; requestBodyState: 'pending' | 'captured' | 'omitted'; requestBodyTruncated: boolean }
export interface NetworkResponseDetails { requestId: string; url: string; status?: number; headers: Readonly<Record<string, string>>; body?: string; bodyState: 'pending' | 'captured' | 'omitted' | 'error'; truncated: boolean; reason?: string }
export interface NetworkListResult { capture: CaptureStatus; requests: readonly NetworkRequestSummary[]; nextOffset?: number }
export interface NetworkToolsHost {
  startCapture(input: NetworkCaptureOptions, ctx: NetworkCallContext): Promise<CaptureStatus>
  stopCapture(input: CaptureInput, ctx: NetworkCallContext): Promise<CaptureStatus>
  listRequests(input: NetworkListInput, ctx: NetworkCallContext): Promise<NetworkListResult>
  getRequest(input: RequestInput, ctx: NetworkCallContext): Promise<NetworkRequestDetails>
  getResponse(input: RequestInput, ctx: NetworkCallContext): Promise<NetworkResponseDetails>
  waitForRequest(input: NetworkWaitInput, ctx: NetworkCallContext): Promise<NetworkRequestSummary>
}
export interface WindowNetworkRecorderOptions { window: Window; maxRequests?: number; maxBodyChars?: number; maxAgeMs?: number; retainForDocument?: boolean }

export interface ObservedRecord {
  request: NetworkRequestDetails
  response: NetworkResponseDetails
  document: Document
}
