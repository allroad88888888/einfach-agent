// Safe CRUD handlers for third-party OpenAI-compatible connection profiles.
// Every returned value is public metadata; API keys only cross into credentialSection.ts.

import {
  normalizeConnectionProfile,
  normalizeConnectionProfileId,
  type ConnectionProfileSaveFields,
  type StoredConnectionProfile,
} from './connectionProfile'
import {
  deleteConnectionProfileRecord,
  listConnectionProfileRecords,
  readConnectionProfileRecord,
  saveConnectionProfileRecord,
} from './connectionProfileTransaction'
import {
  probeConnectionProfileModels,
  type ConnectionProfileProbeDeps,
} from './connectionProfileProbe'
import { modelRequestError } from './errors'
import { definedKeys, hasExactKeys, isJsonRecord } from './wireShape'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostCommandHandler } from '../routeTable'

const SAVE_INPUT_KEYS = ['id', 'label', 'baseUrl', 'models'] as const
const SAVE_INPUT_KEYS_WITH_CREDENTIAL = [...SAVE_INPUT_KEYS, 'apiKey'] as const
const PROBE_INPUT_KEYS = ['baseUrl'] as const
const PROBE_INPUT_KEYS_WITH_CREDENTIAL = [...PROBE_INPUT_KEYS, 'apiKey'] as const

function invalidRequest(): never {
  throw modelRequestError('invalidRequest')
}

function narrowIdArgs(args: Record<string, unknown>): string {
  if (!hasExactKeys(args, ['id'])) invalidRequest()
  return normalizeConnectionProfileId(args.id)
}

function narrowSaveInput(value: unknown): {
  profile: StoredConnectionProfile
  apiKey: string | undefined
} {
  if (!isJsonRecord(value)) invalidRequest()
  const keys = definedKeys(value)
  const expected = value.apiKey === undefined ? SAVE_INPUT_KEYS : SAVE_INPUT_KEYS_WITH_CREDENTIAL
  if (keys.length !== expected.length || !keys.every((key) => expected.includes(key as never))) {
    invalidRequest()
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') invalidRequest()
  return {
    profile: normalizeConnectionProfile(value as unknown as ConnectionProfileSaveFields),
    apiKey: value.apiKey as string | undefined,
  }
}

function narrowProbeInput(value: unknown): { baseUrl: string; apiKey?: string } {
  if (!isJsonRecord(value)) invalidRequest()
  const keys = definedKeys(value)
  const expected = value.apiKey === undefined
    ? PROBE_INPUT_KEYS
    : PROBE_INPUT_KEYS_WITH_CREDENTIAL
  if (keys.length !== expected.length || !keys.every((key) => expected.includes(key as never))) {
    invalidRequest()
  }
  if (typeof value.baseUrl !== 'string') invalidRequest()
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') invalidRequest()
  return { baseUrl: value.baseUrl, ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }) }
}

export function createConnectionProfileProbeHandler(
  deps: ConnectionProfileProbeDeps = {},
): NodeHostCommandHandler {
  return async (args) => {
    if (!hasExactKeys(args, ['input'])) invalidRequest()
    return probeConnectionProfileModels(narrowProbeInput(args.input), deps)
  }
}

export function createConnectionProfileListHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    if (definedKeys(args).length !== 0) invalidRequest()
    return listConnectionProfileRecords(options)
  }
}

export function createConnectionProfileReadHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    const profile = await readConnectionProfileRecord(options, narrowIdArgs(args))
    return profile ?? null
  }
}

export function createConnectionProfileSaveHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    if (!hasExactKeys(args, ['input'])) invalidRequest()
    const { profile, apiKey } = narrowSaveInput(args.input)
    return saveConnectionProfileRecord(options, profile, apiKey)
  }
}

export function createConnectionProfileDeleteHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    const id = narrowIdArgs(args)
    return { deleted: await deleteConnectionProfileRecord(options, id) }
  }
}
