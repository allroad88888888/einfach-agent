// `config.json` 的 `modelConnections` 元数据段视图。
// 本文件只持久化非秘密 profile 字段；凭据始终留在 credentialSection.ts。

import { resolveConfigPathsFromOptions } from '../config/configPaths'
import { createWebAgentConfigStore } from '../config/webAgentConfigStore'
import { modelRequestError } from './errors'
import {
  normalizeStoredConnectionProfile,
  type StoredConnectionProfile,
} from './connectionProfile'
import type { NodeHostInvokeOptions } from '../hostOptions'

export const MODEL_CONNECTIONS_SECTION = 'modelConnections'

async function openStore(options: NodeHostInvokeOptions) {
  return createWebAgentConfigStore(await resolveConfigPathsFromOptions(options))
}

function invalidConfig(): never {
  throw modelRequestError('invalidConfigFormat')
}

/** Decode the complete section so one malformed entry cannot be silently ignored or overwritten. */
export function decodeConnectionProfiles(
  section: unknown,
): Map<string, StoredConnectionProfile> {
  if (section === undefined) return new Map()
  if (typeof section !== 'object' || section === null || Array.isArray(section)) invalidConfig()

  const profiles = new Map<string, StoredConnectionProfile>()
  try {
    for (const [storedId, rawProfile] of Object.entries(section as Record<string, unknown>)) {
      const profile = normalizeStoredConnectionProfile(rawProfile)
      if (profile.id !== storedId || profiles.has(profile.id)) invalidConfig()
      profiles.set(profile.id, profile)
    }
  } catch {
    invalidConfig()
  }
  return profiles
}

export function encodeConnectionProfiles(profiles: Map<string, StoredConnectionProfile>): unknown {
  if (profiles.size === 0) return undefined
  return Object.fromEntries([...profiles].sort(([left], [right]) => (left < right ? -1 : 1)))
}

export async function listStoredConnectionProfiles(
  options: NodeHostInvokeOptions,
): Promise<StoredConnectionProfile[]> {
  const store = await openStore(options)
  return [...decodeConnectionProfiles(await store.readSection(MODEL_CONNECTIONS_SECTION)).values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id === right.id ? 0 : 1))
}

export async function readStoredConnectionProfile(
  options: NodeHostInvokeOptions,
  id: string,
): Promise<StoredConnectionProfile | undefined> {
  return (await listStoredConnectionProfiles(options)).find((profile) => profile.id === id)
}

export async function writeStoredConnectionProfile(
  options: NodeHostInvokeOptions,
  profile: StoredConnectionProfile,
): Promise<void> {
  const store = await openStore(options)
  await store.updateSection(MODEL_CONNECTIONS_SECTION, (current) => {
    const profiles = decodeConnectionProfiles(current)
    profiles.set(profile.id, profile)
    return encodeConnectionProfiles(profiles)
  })
}

/** Returns whether metadata existed. Absence is not an error. */
export async function deleteStoredConnectionProfile(
  options: NodeHostInvokeOptions,
  id: string,
): Promise<boolean> {
  const store = await openStore(options)
  let deleted = false
  await store.updateSection(MODEL_CONNECTIONS_SECTION, (current) => {
    const profiles = decodeConnectionProfiles(current)
    deleted = profiles.delete(id)
    return encodeConnectionProfiles(profiles)
  })
  return deleted
}
