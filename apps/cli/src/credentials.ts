import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ModelCredentials {
  deepseekApiKey: string
  glmApiKey: string
  kimiApiKey: string
}

export interface ResolvedCredentials extends ModelCredentials {
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

function valueFromEnv(value: string | undefined): string {
  return value?.trim() ?? ''
}

function valueFromConfig(config: CredentialConfig, key: string): string {
  const value = config.modelCredentials?.[key]
  return typeof value === 'string' ? value.trim() : ''
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
  const fromEnvironment: ModelCredentials = {
    deepseekApiKey: valueFromEnv(env.DEEPSEEK_API_KEY),
    glmApiKey: valueFromEnv(env.GLM_API_KEY),
    kimiApiKey: valueFromEnv(env.KIMI_API_KEY),
  }

  // DeepSeek is the default model. Its environment variable is a complete no-file path,
  // so a malformed optional config cannot break a correctly configured CLI invocation.
  if (fromEnvironment.deepseekApiKey) return { ...fromEnvironment, configPath }

  const config = await readConfig(configPath, options.readConfigFile ?? readFile)
  return {
    deepseekApiKey: valueFromEnvironmentOrConfig(fromEnvironment.deepseekApiKey, config, 'deepseek:default'),
    glmApiKey: valueFromEnvironmentOrConfig(fromEnvironment.glmApiKey, config, 'glm:default'),
    kimiApiKey: valueFromEnvironmentOrConfig(fromEnvironment.kimiApiKey, config, 'kimi:cn'),
    configPath,
  }
}

function valueFromEnvironmentOrConfig(environmentValue: string, config: CredentialConfig, key: string): string {
  return environmentValue || valueFromConfig(config, key)
}

/** Throws a user-facing error without including the credential value. */
export function requireDeepSeekCredential(credentials: ResolvedCredentials): void {
  if (credentials.deepseekApiKey) return
  throw new Error(
    `未找到 DeepSeek API Key。请设置环境变量 DEEPSEEK_API_KEY，或在配置文件 ${credentials.configPath} 中配置 modelCredentials["deepseek:default"]。`,
  )
}
