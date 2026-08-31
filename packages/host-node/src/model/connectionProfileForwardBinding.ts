// 从同一次受锁配置快照解析第三方连接的端点与凭据，禁止跨快照混配。

import { resolveConfigPathsFromOptions } from '../config/configPaths'
import { createWebAgentConfigStore } from '../config/webAgentConfigStore'
import type { NodeHostInvokeOptions } from '../hostOptions'
import { connectionProfileCredentialKey } from './connectionProfile'
import {
  decodeConnectionProfiles,
  MODEL_CONNECTIONS_SECTION,
} from './connectionProfileSection'
import {
  MODEL_CREDENTIAL_SECTION,
  normalizeApiKey,
  readModelCredentialSnapshotKey,
} from './credentialSection'
import type { RegisteredProviderOrigins } from './registeredProviderOrigin'

const PROFILE_FORWARD_SECTIONS = [
  MODEL_CONNECTIONS_SECTION,
  MODEL_CREDENTIAL_SECTION,
] as const

export interface ConnectionProfileForwardBinding {
  readonly registeredOrigins: RegisteredProviderOrigins
  readonly apiKey?: string
}

/**
 * Profile 不存在时返回空 binding，让唯一 URL 白名单 `resolveProviderTarget` fail closed。
 * Profile 存在时，origin 与 Key 必须来自同一次 `readSections` 快照；Key 只活在转发调用栈。
 */
export async function readConnectionProfileForwardBinding(
  options: NodeHostInvokeOptions,
  connectionId: string,
): Promise<ConnectionProfileForwardBinding> {
  const paths = await resolveConfigPathsFromOptions(options)
  const store = createWebAgentConfigStore(paths)
  const snapshot = await store.readSections(PROFILE_FORWARD_SECTIONS)
  const profile = decodeConnectionProfiles(
    snapshot.get(MODEL_CONNECTIONS_SECTION),
  ).get(connectionId)
  if (profile === undefined) return { registeredOrigins: {} }

  const apiKey = normalizeApiKey(readModelCredentialSnapshotKey(
    snapshot.get(MODEL_CREDENTIAL_SECTION),
    connectionProfileCredentialKey(connectionId),
  ))
  return {
    registeredOrigins: { openAiCompat: profile.baseUrl },
    ...(apiKey === undefined ? {} : { apiKey }),
  }
}
