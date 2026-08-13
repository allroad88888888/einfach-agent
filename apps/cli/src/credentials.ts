import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** CLI 装配层显式登记的凭据来源：vendor id ← 环境变量 / 配置文件键。 */
interface CredentialSource {
  vendor: string
  environmentVariable: string
  configKey: string
}

const CREDENTIAL_SOURCES: readonly CredentialSource[] = [
  { vendor: 'deepseek', environmentVariable: 'DEEPSEEK_API_KEY', configKey: 'deepseek:default' },
  { vendor: 'glm', environmentVariable: 'GLM_API_KEY', configKey: 'glm:default' },
  { vendor: 'kimi', environmentVariable: 'KIMI_API_KEY', configKey: 'kimi:cn' },
]

/** CLI 默认模型的 vendor id：没有它就没法起 run。 */
const DEFAULT_VENDOR = 'deepseek'

export interface ResolvedCredentials {
  /** vendor id → API Key，直接喂给运行时的 `modelCredentials`；未配置的 vendor 不出现。 */
  modelCredentials: Record<string, string>
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
  modelCredentials?: Record<string, unknown>
}

function valueFromConfig(config: CredentialConfig, key: string): string {
  const value = config.modelCredentials?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function credentialsFromEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const credentials: Record<string, string> = {}
  for (const { vendor, environmentVariable } of CREDENTIAL_SOURCES) {
    const value = env[environmentVariable]?.trim() ?? ''
    if (value) credentials[vendor] = value
  }
  return credentials
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

  // DeepSeek is the default model. Its environment variable is a complete no-file path,
  // so a malformed optional config cannot break a correctly configured CLI invocation.
  if (fromEnvironment[DEFAULT_VENDOR]) return { modelCredentials: fromEnvironment, configPath }

  const config = await readConfig(configPath, options.readConfigFile ?? readFile)
  const modelCredentials: Record<string, string> = {}
  for (const { vendor, configKey } of CREDENTIAL_SOURCES) {
    const value = fromEnvironment[vendor] || valueFromConfig(config, configKey)
    if (value) modelCredentials[vendor] = value
  }
  return { modelCredentials, configPath }
}

/** Throws a user-facing error without including the credential value. */
export function requireDeepSeekCredential(credentials: ResolvedCredentials): void {
  if (credentials.modelCredentials[DEFAULT_VENDOR]) return
  throw new Error(
    `未找到 DeepSeek API Key。请设置环境变量 DEEPSEEK_API_KEY，或在配置文件 ${credentials.configPath} 中配置 modelCredentials["deepseek:default"]。`,
  )
}
