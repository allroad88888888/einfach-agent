import type { FieldOutcome, FormSnapshot, PageRef, PageSnapshot, TableSnapshot } from '@einfach-agent/tools-browser-page'
import type { CaptureStatus, NetworkListResult, NetworkRequestDetails, NetworkRequestSummary, NetworkResponseDetails } from '@einfach-agent/tools-browser-network'
import type { DomActionResult, DomSnapshot } from '@einfach-agent/tools-browser-dom'

export const CHANNEL = 'einfach-browser-agent-v1'
export type PageMethod = 'readForm' | 'readPage' | 'readTable' | 'fillFields' | 'validateForm'
export type DomMethod = 'readDom' | 'clickDom' | 'typeDom' | 'pressDomKey' | 'scrollDom' | 'waitForDom'
export type NetworkMethod = 'startCapture' | 'stopCapture' | 'listRequests' | 'getRequest' | 'getResponse' | 'waitForRequest'
export interface TargetBinding { tabId: number; frameId: number; targetId: string; documentId: string; revision: number; title: string; url: string }
export interface PageRequest { channel: typeof CHANNEL; kind: 'page-call'; requestId: string; target: TargetBinding; sessionId: string; method: PageMethod | DomMethod; input?: unknown }
export interface CancelRequest { channel: typeof CHANNEL; kind: 'cancel-page-call'; requestId: string; target: TargetBinding }
export interface NetworkRequest { channel: typeof CHANNEL; kind: 'network-call'; requestId: string; target: TargetBinding; sessionId: string; method: NetworkMethod; input: unknown }
export interface CancelNetworkRequest { channel: typeof CHANNEL; kind: 'cancel-network-call'; requestId: string; target: TargetBinding; sessionId: string }
export interface HandshakeRequest { channel: typeof CHANNEL; kind: 'handshake'; tabId: number; frameId: number }
export type ExtensionRequest = PageRequest | CancelRequest | NetworkRequest | CancelNetworkRequest | HandshakeRequest
export type PageResult = FormSnapshot | PageSnapshot | TableSnapshot | readonly FieldOutcome[] | DomSnapshot | DomActionResult
export type NetworkResult = CaptureStatus | NetworkListResult | NetworkRequestDetails | NetworkResponseDetails | NetworkRequestSummary
export type ExtensionResponse = { ok: true; data: PageResult | NetworkResult | TargetBinding | null } | { ok: false; code: string; error: string; unknownResult?: boolean }

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function isRequest(value: unknown): value is ExtensionRequest {
  if (!isRecord(value) || value.channel !== CHANNEL || typeof value.kind !== 'string') return false
  if (value.kind === 'handshake') return Number.isInteger(value.tabId) && Number.isInteger(value.frameId)
  if (!isRecord(value.target) || typeof value.requestId !== 'string') return false
  if (value.kind === 'cancel-page-call') return true
  if (value.kind === 'cancel-network-call') return typeof value.sessionId === 'string'
  if (value.kind === 'page-call') return typeof value.sessionId === 'string' && ['readForm', 'readPage', 'readTable', 'fillFields', 'validateForm', 'readDom', 'clickDom', 'typeDom', 'pressDomKey', 'scrollDom', 'waitForDom'].includes(String(value.method))
  return value.kind === 'network-call' && typeof value.sessionId === 'string' && ['startCapture', 'stopCapture', 'listRequests', 'getRequest', 'getResponse', 'waitForRequest'].includes(String(value.method))
}
export function pageRef(target: TargetBinding): PageRef { return { targetId: target.targetId, documentId: target.documentId, revision: target.revision } }

export function isTarget(value: unknown): value is TargetBinding {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TargetBinding>
  return Number.isInteger(item.tabId) && Number.isInteger(item.frameId) && typeof item.targetId === 'string' && typeof item.documentId === 'string' && Number.isInteger(item.revision) && typeof item.url === 'string' && typeof item.title === 'string'
}
