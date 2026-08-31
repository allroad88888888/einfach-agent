// 一条第三方连接的元数据与凭据在同一配置快照中原子变更。

import { resolveConfigPathsFromOptions } from '../config/configPaths'
import { createWebAgentConfigStore } from '../config/webAgentConfigStore'
import type { NodeHostInvokeOptions } from '../hostOptions'
import {
  connectionProfileCredentialKey,
  type ModelConnectionProfile,
  type StoredConnectionProfile,
} from './connectionProfile'
import {
  decodeConnectionProfiles,
  encodeConnectionProfiles,
  MODEL_CONNECTIONS_SECTION,
} from './connectionProfileSection'
import {
  editModelCredentialSection,
  MODEL_CREDENTIAL_SECTION,
  normalizeApiKey,
} from './credentialSection'
import { ModelRequestError, modelRequestError } from './errors'

const PROFILE_SECTIONS = [MODEL_CONNECTIONS_SECTION, MODEL_CREDENTIAL_SECTION] as const

async function openStore(options: NodeHostInvokeOptions) {
  return createWebAgentConfigStore(await resolveConfigPathsFromOptions(options))
}

function decodeSnapshot(current: ReadonlyMap<string, unknown>) {
  return {
    profiles: decodeConnectionProfiles(current.get(MODEL_CONNECTIONS_SECTION)),
    credentials: editModelCredentialSection(current.get(MODEL_CREDENTIAL_SECTION)),
  }
}

function publicProfile(
  profile: StoredConnectionProfile,
  credentialConfigured: boolean,
): ModelConnectionProfile {
  return { ...profile, credentialConfigured }
}

export async function listConnectionProfileRecords(
  options: NodeHostInvokeOptions,
): Promise<ModelConnectionProfile[]> {
  const snapshot = await (await openStore(options)).readSections(PROFILE_SECTIONS)
  const { profiles, credentials } = decodeSnapshot(snapshot)
  return [...profiles.values()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id === right.id ? 0 : 1))
    .map((profile) => publicProfile(
      profile,
      credentials.configured(connectionProfileCredentialKey(profile.id)),
    ))
}

export async function readConnectionProfileRecord(
  options: NodeHostInvokeOptions,
  id: string,
): Promise<ModelConnectionProfile | undefined> {
  return (await listConnectionProfileRecords(options)).find((profile) => profile.id === id)
}

export async function saveConnectionProfileRecord(
  options: NodeHostInvokeOptions,
  profile: StoredConnectionProfile,
  apiKey: string | undefined,
): Promise<ModelConnectionProfile> {
  const suppliedKey = apiKey === undefined ? undefined : normalizeApiKey(apiKey)
  if (apiKey !== undefined && suppliedKey === undefined) throw modelRequestError('invalidApiKey')

  const store = await openStore(options)
  let saved: ModelConnectionProfile | undefined
  await store.updateSections(PROFILE_SECTIONS, (current) => {
    const { profiles, credentials } = decodeSnapshot(current)
    const credentialKey = connectionProfileCredentialKey(profile.id)
    if (suppliedKey === undefined && !credentials.configured(credentialKey)) {
      throw new ModelRequestError('credential-missing', '第三方模型连接未配置 API Key')
    }
    if (suppliedKey !== undefined) credentials.set(credentialKey, suppliedKey)
    profiles.set(profile.id, profile)
    saved = publicProfile(profile, true)
    return new Map([
      [MODEL_CONNECTIONS_SECTION, encodeConnectionProfiles(profiles)],
      [MODEL_CREDENTIAL_SECTION, credentials.encode()],
    ])
  })
  if (saved === undefined) throw new Error('连接配置事务未完成')
  return saved
}

export async function deleteConnectionProfileRecord(
  options: NodeHostInvokeOptions,
  id: string,
): Promise<boolean> {
  const store = await openStore(options)
  let deleted = false
  await store.updateSections(PROFILE_SECTIONS, (current) => {
    const { profiles, credentials } = decodeSnapshot(current)
    deleted = profiles.delete(id)
    credentials.delete(connectionProfileCredentialKey(id))
    return new Map([
      [MODEL_CONNECTIONS_SECTION, encodeConnectionProfiles(profiles)],
      [MODEL_CREDENTIAL_SECTION, credentials.encode()],
    ])
  })
  return deleted
}
