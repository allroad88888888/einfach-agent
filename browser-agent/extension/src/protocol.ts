import type { FieldOutcome, FormSnapshot, PageRef } from '@einfach-agent/tools-browser-page'

export const CHANNEL = 'einfach-browser-agent-v1'
export type PageMethod = 'readForm' | 'fillFields' | 'validateForm'
export interface TargetBinding { tabId: number; frameId: number; targetId: string; documentId: string; revision: number; title: string; url: string }
export interface PageRequest { channel: typeof CHANNEL; kind: 'page-call'; requestId: string; target: TargetBinding; sessionId: string; method: PageMethod; input?: unknown }
export interface CancelRequest { channel: typeof CHANNEL; kind: 'cancel-page-call'; requestId: string; target: TargetBinding }
export interface HandshakeRequest { channel: typeof CHANNEL; kind: 'handshake'; tabId: number; frameId: number }
export type ExtensionRequest = PageRequest | CancelRequest | HandshakeRequest
export type PageResult = FormSnapshot | readonly FieldOutcome[]
export type ExtensionResponse = { ok: true; data: PageResult | TargetBinding } | { ok: false; code: string; error: string; unknownResult?: boolean }

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function isRequest(value: unknown): value is ExtensionRequest {
  if (!isRecord(value) || value.channel !== CHANNEL || typeof value.kind !== 'string') return false
  if (value.kind === 'handshake') return Number.isInteger(value.tabId) && Number.isInteger(value.frameId)
  if (!isRecord(value.target) || typeof value.requestId !== 'string') return false
  return value.kind === 'cancel-page-call' || (value.kind === 'page-call' && typeof value.sessionId === 'string' && ['readForm', 'fillFields', 'validateForm'].includes(String(value.method)))
}
export function pageRef(target: TargetBinding): PageRef { return { targetId: target.targetId, documentId: target.documentId, revision: target.revision } }
