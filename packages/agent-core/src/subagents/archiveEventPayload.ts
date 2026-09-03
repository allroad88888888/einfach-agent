export const CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION = 1 as const

type ChildArchiveStatus = 'done' | 'failed' | 'cancelled'
type ChildArchiveModelTier = 'flash' | 'pro'

export interface ChildArchiveChangeSet {
  id: string
  reversible: boolean
}

export interface ChildStartedArchivePayload extends Record<string, unknown> {
  child_payload_version: typeof CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION
  objective: string
  mode?: string
  modelTier?: ChildArchiveModelTier
  model?: string
  route_reason?: string
  fallback_count?: number
  requiresTemporalNormalization?: boolean
  toolProfile?: string
  confirmedTools?: readonly string[]
  skillId?: string
  inheritedSkillIds?: readonly string[]
}

type ChildStartedArchivePayloadInput = {
  objective: string
  mode?: string
  modelTier?: ChildArchiveModelTier
  model?: string
  route_reason?: string
  fallback_count?: number
  requiresTemporalNormalization?: boolean
  toolProfile?: string
  confirmedTools?: readonly string[]
  skillId?: string
  inheritedSkillIds?: readonly string[]
}

export interface ChildFinishedArchivePayload extends Record<string, unknown> {
  child_payload_version: typeof CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION
  status: ChildArchiveStatus
  objective: string
  summary: string
  resultFile?: string
  skillFiles: string[]
  skillIds: string[]
  changeSets: ChildArchiveChangeSet[]
  modelTier?: ChildArchiveModelTier
  route_reason?: string
  fallback_count?: number
  error?: string
}

type ChildFinishedArchivePayloadInput = {
  status: ChildArchiveStatus
  objective: string
  summary: string
  resultFile?: string
  skillFiles: string[]
  skillIds: string[]
  changeSets: ChildArchiveChangeSet[]
  modelTier?: ChildArchiveModelTier
  route_reason?: string
  fallback_count?: number
  error?: string
}

export interface DecodedChildStartedArchivePayload {
  objective?: string
  modelTier?: ChildArchiveModelTier
  routeReason?: string
  fallbackCount?: number
  skillId?: string
  inheritedSkillIds?: string[]
}

export interface DecodedChildFinishedArchivePayload {
  status?: ChildArchiveStatus
  objective?: string
  summary?: string
  resultFile?: string
  skillFiles?: string[]
  skillIds?: string[]
  changeSets?: ChildArchiveChangeSet[]
  modelTier?: ChildArchiveModelTier
  routeReason?: string
  fallbackCount?: number
  error?: string
}

/** Creates the versioned payload emitted before a child begins its model loop. */
export function createChildStartedArchivePayload(
  input: ChildStartedArchivePayloadInput,
): ChildStartedArchivePayload {
  return {
    child_payload_version: CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION,
    ...input,
    ...(input.confirmedTools ? { confirmedTools: [...input.confirmedTools] } : {}),
    ...(input.inheritedSkillIds ? { inheritedSkillIds: [...input.inheritedSkillIds] } : {}),
  }
}

/** Creates the versioned terminal payload that must reproduce a ChildAgentResult. */
export function createChildFinishedArchivePayload(
  input: ChildFinishedArchivePayloadInput,
): ChildFinishedArchivePayload {
  return {
    child_payload_version: CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION,
    ...input,
    skillFiles: [...input.skillFiles],
    skillIds: [...input.skillIds],
    changeSets: input.changeSets.map((changeSet) => ({ ...changeSet })),
  }
}

/** Decodes the current payload version and the pre-versioned archive shape. */
export function decodeChildStartedArchivePayload(value: unknown): DecodedChildStartedArchivePayload | undefined {
  const data = record(value)
  if (!data || !supportedVersion(data)) return undefined
  if (isVersioned(data) && (!string(data.objective)
    || !optional(data, 'mode', string)
    || !optional(data, 'modelTier', validModelTier)
    || !optional(data, 'model', string)
    || !optional(data, 'route_reason', string)
    || !optional(data, 'fallback_count', validFallbackCount)
    || !optional(data, 'requiresTemporalNormalization', boolean)
    || !optional(data, 'toolProfile', string)
    || !optional(data, 'confirmedTools', validStringArray)
    || !optional(data, 'skillId', string)
    || !optional(data, 'inheritedSkillIds', validStringArray)
  )) return undefined
  return {
    ...(string(data.objective) ? { objective: data.objective } : {}),
    ...(modelTier(data.modelTier) ? { modelTier: modelTier(data.modelTier) } : {}),
    ...(string(data.route_reason) ? { routeReason: data.route_reason } : {}),
    ...(fallbackCount(data.fallback_count) !== undefined ? { fallbackCount: fallbackCount(data.fallback_count) } : {}),
    ...(string(data.skillId) ? { skillId: data.skillId } : {}),
    ...(stringArray(data.inheritedSkillIds) ? { inheritedSkillIds: stringArray(data.inheritedSkillIds) } : {}),
  }
}

/** Decodes the current payload version and the pre-versioned terminal event shape. */
export function decodeChildFinishedArchivePayload(value: unknown): DecodedChildFinishedArchivePayload | undefined {
  const data = record(value)
  if (!data || !supportedVersion(data)) return undefined
  const parsedChangeSets = changeSets(data.changeSets)
  if (isVersioned(data) && (
    !status(data.status) || !string(data.objective) || !string(data.summary)
    || !stringArray(data.skillFiles) || !stringArray(data.skillIds) || !parsedChangeSets
    || !optional(data, 'resultFile', string)
    || !optional(data, 'modelTier', validModelTier)
    || !optional(data, 'route_reason', string)
    || !optional(data, 'fallback_count', validFallbackCount)
    || !optional(data, 'error', string)
  )) return undefined
  return {
    ...(status(data.status) ? { status: status(data.status) } : {}),
    ...(string(data.objective) ? { objective: data.objective } : {}),
    ...(string(data.summary) ? { summary: data.summary } : {}),
    ...(string(data.resultFile) ? { resultFile: data.resultFile } : {}),
    ...(stringArray(data.skillFiles) ? { skillFiles: stringArray(data.skillFiles) } : {}),
    ...(stringArray(data.skillIds) ? { skillIds: stringArray(data.skillIds) } : {}),
    ...(parsedChangeSets ? { changeSets: parsedChangeSets } : {}),
    ...(modelTier(data.modelTier) ? { modelTier: modelTier(data.modelTier) } : {}),
    ...(string(data.route_reason) ? { routeReason: data.route_reason } : {}),
    ...(fallbackCount(data.fallback_count) !== undefined ? { fallbackCount: fallbackCount(data.fallback_count) } : {}),
    ...(string(data.error) ? { error: data.error } : {}),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function supportedVersion(data: Record<string, unknown>): boolean {
  return data.child_payload_version === undefined
    || data.child_payload_version === CHILD_ARCHIVE_EVENT_PAYLOAD_VERSION
}

function isVersioned(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, 'child_payload_version')
}

function string(value: unknown): value is string {
  return typeof value === 'string'
}

function boolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function optional(data: Record<string, unknown>, key: string, valid: (value: unknown) => boolean): boolean {
  return data[key] === undefined || valid(data[key])
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(string) ? [...value] : undefined
}

function validStringArray(value: unknown): boolean {
  return stringArray(value) !== undefined
}

function status(value: unknown): ChildArchiveStatus | undefined {
  return value === 'done' || value === 'failed' || value === 'cancelled' ? value : undefined
}

function modelTier(value: unknown): ChildArchiveModelTier | undefined {
  return value === 'flash' || value === 'pro' ? value : undefined
}

function validModelTier(value: unknown): boolean {
  return modelTier(value) !== undefined
}

function fallbackCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined
}

function validFallbackCount(value: unknown): boolean {
  return fallbackCount(value) !== undefined
}

function changeSets(value: unknown): ChildArchiveChangeSet[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value.map(record)
  if (parsed.some((changeSet) => !changeSet || !string(changeSet.id) || typeof changeSet.reversible !== 'boolean')) {
    return undefined
  }
  return parsed.map((changeSet) => ({ id: changeSet!.id as string, reversible: changeSet!.reversible as boolean }))
}
