import { MAX_LIMIT, MAX_TEXT } from './constants'
import type { DomActionResult, DomNode, DomSnapshot, PageRef } from './types'

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const optionalString = (value: unknown, max = MAX_TEXT): boolean => value === undefined || (typeof value === 'string' && value.length <= max)
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean'
const pageRef = (value: unknown): value is PageRef => record(value) && typeof value.targetId === 'string' && value.targetId.length > 0 && value.targetId.length <= MAX_TEXT && typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.length <= MAX_TEXT && Number.isInteger(value.revision) && (value.revision as number) >= 0

function domNode(value: unknown): value is DomNode {
  if (!record(value) || typeof value.ref !== 'string' || !value.ref || value.ref.length > MAX_TEXT || typeof value.tag !== 'string' || !value.tag || value.tag.length > 50 || typeof value.name !== 'string' || value.name.length > MAX_TEXT) return false
  if (!optionalString(value.parentRef) || !optionalString(value.role) || !optionalString(value.text) || !optionalString(value.value)) return false
  if (!optionalBoolean(value.disabled) || !optionalBoolean(value.readOnly) || !optionalBoolean(value.expanded) || !optionalBoolean(value.selected) || !optionalBoolean(value.checked)) return false
  if (value.attributes !== undefined && (!record(value.attributes) || Object.keys(value.attributes).length > 20 || !Object.keys(value.attributes).every((key) => key.length <= 50) || !Object.values(value.attributes).every((item) => typeof item === 'string' && item.length <= MAX_TEXT))) return false
  return true
}

export function isDomSnapshot(value: unknown): value is DomSnapshot {
  return record(value) && pageRef(value.page) && Array.isArray(value.nodes) && value.nodes.length <= MAX_LIMIT && value.nodes.every(domNode) && typeof value.truncated === 'boolean' && (value.nextOffset === undefined || (Number.isInteger(value.nextOffset) && (value.nextOffset as number) >= 0))
}

export function isDomActionResult(value: unknown): value is DomActionResult {
  return record(value) && pageRef(value.page) && typeof value.ref === 'string' && Boolean(value.ref) && value.ref.length <= MAX_TEXT && value.dispatched === true && (value.node === undefined || domNode(value.node))
}
