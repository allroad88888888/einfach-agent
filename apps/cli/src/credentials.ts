import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  credentialConfigKey,
  normalizeApiKey,
  normalizeOpenAiCompatBaseUrl,
  OPENAI_COMPAT_BASE_URL_CONFIG_KEY,
  readModelCredentialSnapshotKey,
} from '@einfach-agent/host-node'
import type { ModelProviderName, ProviderScope } from '@einfach-agent/host-node'

/**
 * CLI 装配层显式登记的凭据来源：vendor id ← 环境变量；配置键由 host-node 的绑定表得出。
 * baseUrl 两个字段是可选的——只有没有厂商官方接入点的 vendor（目前只有 openai-compat）
 * 才需要；deepseek/glm/kimi 各自在 agent-ai adapter 里有域名常量，不必在这里配。
 */
interface CredentialSource {
  vendor: ModelProviderName
  scope: ProviderScope
  environmentVariable: string
  baseUrlEnvironmentVariable?: string
}

const CREDENTIAL_SOURCES: readonly CredentialSource[] = [
  { vendor: 'deepseek', scope: 'default', environmentVariable: 'DEEPSEEK_API_KEY' },
  { vendor: 'glm', scope: 'default', environmentVariable: 'GLM_API_KEY' },
  { vendor: 'kimi', scope: 'cn', environmentVariable: 'KIMI_API_KEY' },
  {
    vendor: 'openai-compat',
    scope: 'default',
    environmentVariable: 'OPENAI_COMPAT_API_KEY',
    baseUrlEnvironmentVariable: 'OPENAI_COMPAT_BASE_URL',
  },
]

/** CLI 默认模型的 vendor id：没有它就没法起 run。 */
const DEFAULT_VENDOR = 'deepseek'

export interface ResolvedCredentials {
  /** vendor id → API Key，直接喂给运行时的 `modelCredentials`；未配置的 vendor 不出现。 */
  modelCredentials: Record<string, string>
  /**
   * vendor id → 接入点覆盖；只有 openai-compat 这类没有官方域名的 vendor 才会出现。
   * 装配层（runtime.ts）用它给 openai-compat adapter 烘焙默认 baseUrl，不喂给 core——
   * core 的 `modelCredentials` 表只认 API Key，没有 baseUrl 的位置。
   */
  modelBaseUrls: Record<string, string>
  configPath: string
}

type ReadConfigFile = (path: string, encoding: 'utf8') => Promise<string>

interface ResolveCredentialOptions {
  configPath?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  readConfigFile?: ReadConfigFile
}

interface CredentialConfig {
  modelCredentials?: unknown
}

function valueFromConfig(config: CredentialConfig, key: string): string {
  return normalizeApiKey(readModelCredentialSnapshotKey(config.modelCredentials, key)) ?? ''
}

function credentialsFromEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const credentials: Record<string, string> = {}
  for (const { vendor, environmentVariable } of CREDENTIAL_SOURCES) {
    const value = normalizeApiKey(env[environmentVariable]) ?? ''
    if (value) credentials[vendor] = value
  }
  return credentials
}

function baseUrlsFromEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const baseUrls: Record<string, string> = {}
  for (const { vendor, baseUrlEnvironmentVariable } of CREDENTIAL_SOURCES) {
    if (!baseUrlEnvironmentVariable) continue
    const value = normalizeOpenAiCompatBaseUrl(env[baseUrlEnvironmentVariable] ?? '') ?? ''
    if (value) baseUrls[vendor] = value
  }
  return baseUrls
}

function configFilePath(options: ResolveCredentialOptions): string {
  return resolve(options.configPath ?? join(options.homeDirectory ?? homedir(), '.webAgent', 'config.json'))
}

async function readConfig(path: string, reader: ReadConfigFile): Promise<CredentialConfig> {
  try {
    const raw = await reader(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是对象')
    }
    return parsed as CredentialConfig
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return {}
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取凭证配置文件：${path}（${detail}）`)
  }
}

/** Resolves environment credentials first, then the read-only local config file. */
export async function resolveModelCredentials(
  options: ResolveCredentialOptions = {},
): Promise<ResolvedCredentials> {
  const env = options.env ?? process.env
  const configPath = configFilePath(options)
  const fromEnvironment = credentialsFromEnvironment(env)
  const baseUrlsFromEnv = baseUrlsFromEnvironment(env)

  // DeepSeek is the default model. Its environment variable is a complete no-file path,
  // so a malformed optional config cannot break a correctly configured CLI invocation.
  if (fromEnvironment[DEFAULT_VENDOR]) {
    return { modelCredentials: fromEnvironment, modelBaseUrls: baseUrlsFromEnv, configPath }
  }

  const config = await readConfig(configPath, options.readConfigFile ?? readFile)
  const modelCredentials: Record<string, string> = {}
  const modelBaseUrls: Record<string, string> = { ...baseUrlsFromEnv }
  for (const source of CREDENTIAL_SOURCES) {
    const { vendor } = source
    const configKey = credentialConfigKey(source.vendor, source.scope)
    const value = fromEnvironment[vendor] || valueFromConfig(config, configKey)
    if (value) modelCredentials[vendor] = value
    if (vendor === 'openai-compat' && !modelBaseUrls[vendor]) {
      const baseUrl = normalizeOpenAiCompatBaseUrl(
        readModelCredentialSnapshotKey(config.modelCredentials, OPENAI_COMPAT_BASE_URL_CONFIG_KEY) ?? '',
      )
      if (baseUrl) modelBaseUrls[vendor] = baseUrl
    }
  }
  return { modelCredentials, modelBaseUrls, configPath }
}

/** Throws a user-facing error without including the credential value. */
export function requireDeepSeekCredential(credentials: ResolvedCredentials): void {
  if (credentials.modelCredentials[DEFAULT_VENDOR]) return
  throw new Error(
    `未找到 DeepSeek API Key。请设置环境变量 DEEPSEEK_API_KEY，或在配置文件 ${credentials.configPath} 中配置 modelCredentials["deepseek:default"]。`,
  )
}
