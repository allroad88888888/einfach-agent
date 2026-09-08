import type { SessionMeta } from './core.type'
import {
  createLockedEmptySessionCapabilityPolicy,
  isSessionCapabilityPolicy,
} from './sessionCapabilityPolicy'

/** Sanitizes the untrusted persisted capability field without changing legacy sessions. */
export function sanitizeSessionCapabilityPolicy(session: SessionMeta): SessionMeta {
  if (!Object.prototype.hasOwnProperty.call(session, 'capabilityPolicy')) return session
  const candidate = (session as unknown as Record<string, unknown>).capabilityPolicy
  if (isSessionCapabilityPolicy(candidate)) return session
  return { ...session, capabilityPolicy: createLockedEmptySessionCapabilityPolicy() }
}
