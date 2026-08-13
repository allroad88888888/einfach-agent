import { normalizeDeepSeekUserId } from '@web-agent/ai'
import {
  normalizeDisabledProjectSkills,
  type DisabledProjectSkillsByWorkspace,
} from '@web-agent/core/skills/projectSkillPreferences'

export const APP_SETTINGS_VERSION = 3 as const
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 12_000
export const MAX_MODEL_API_KEY_LENGTH = 1_024
export const INSTALLATION_ID_RANDOM_BYTES = 24
export const INSTALLATION_ID_PREFIX = 'wa_'
const INSTALLATION_ID_PATTERN = new RegExp(
  `^${INSTALLATION_ID_PREFIX}[a-f0-9]{${INSTALLATION_ID_RANDOM_BYTES * 2}}$`,
)

type FillRandomBytes = (target: Uint8Array) => void

function fillRandomBytes(target: Uint8Array): void {
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(target)
    return
  }

  // 极旧 WebView 的最后兜底；仍只使用本地随机数，不混入用户名、路径、邮箱、设备名等信息。
  for (let index = 0; index < target.length; index += 1) {
    target[index] = Math.floor(Math.random() * 256)
  }
}

/**
 * 生成仅由随机字节组成的不透明安装标识。
 *
 * 固定 `wa_` + 48 位十六进制（192 bit），不会编码姓名、邮箱、路径或其它设备信息，
 * 同时天然满足 DeepSeek `[A-Za-z0-9_-]+` / 512 字符上限。
 */
export function createInstallationId(
  randomBytes: FillRandomBytes = fillRandomBytes,
): string {
  const bytes = new Uint8Array(INSTALLATION_ID_RANDOM_BYTES)
  randomBytes(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${INSTALLATION_ID_PREFIX}${hex}`
}

export function isInstallationId(value: unknown): value is string {
  return (
    normalizeDeepSeekUserId(value) !== undefined
    && INSTALLATION_ID_PATTERN.test(value as string)
  )
}

/**
 * 用户可持久化的全局设置。
 *
 * 这里只放稳定的配置数据；表单草稿、loading/error、MCP 连接状态和运行时依赖
 * 继续留在各自的状态域中。
 */
export interface AppSettings {
  version: typeof APP_SETTINGS_VERSION
  installationId: string
  agent: {
    customInstructions: string
    disabledProjectSkills: DisabledProjectSkillsByWorkspace
  }
}

export function createDefaultAppSettings(
  installationId: string = createInstallationId(),
): AppSettings {
  if (!isInstallationId(installationId)) throw new Error('应用设置格式无效')
  return {
    version: APP_SETTINGS_VERSION,
    installationId,
    agent: {
      customInstructions: '',
      disabledProjectSkills: {},
    },
  }
}

export function sanitizeCustomInstructions(value: unknown): string {
  if (typeof value !== 'string') throw new Error('应用设置格式无效')
  return value.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH)
}

export function sanitizeAppSettings(value: unknown): AppSettings {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as { version?: unknown }).version !== APP_SETTINGS_VERSION
  ) {
    throw new Error('应用设置格式无效')
  }

  const installationId = (value as { installationId?: unknown }).installationId
  if (!isInstallationId(installationId)) throw new Error('应用设置格式无效')

  const agent = (value as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) {
    throw new Error('应用设置格式无效')
  }

  return {
    version: APP_SETTINGS_VERSION,
    installationId,
    agent: {
      customInstructions: sanitizeCustomInstructions(
        (agent as { customInstructions?: unknown }).customInstructions,
      ),
      disabledProjectSkills: normalizeDisabledProjectSkills(
        (agent as { disabledProjectSkills?: unknown }).disabledProjectSkills,
      ),
    },
  }
}
