import { uiStore } from '../uiStore'
import {
  configureCommands,
  disabledProjectSkillsByWorkspaceAtom,
  rootStore,
} from '@einfach-agent/core'
import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  sanitizeDefaultModelConnection,
  type AppSettings,
  type DefaultModelConnection,
} from './config'
import { hydrateModelCredentials } from './modelCredentialCommands'
import {
  createBrowserAppSettingsStorage,
  type AppSettingsStorage,
} from './persistence'
import {
  appSettingsAtom,
  customInstructionsAtom,
  customInstructionsDraftAtom,
  customInstructionsStatusAtom,
} from './state'
import { synchronizeDefaultModelConnectionRuntime } from './defaultModelConnectionRuntime'

export {
  configureModelCredentialHost,
  deleteDeepSeekApiKey,
  deleteKimiApiKey,
  deleteModelCredential,
  hydrateModelCredentials,
  saveDeepSeekApiKey,
  saveKimiApiKey,
  saveModelCredential,
  updateDeepSeekApiKeyDraft,
  updateKimiApiKeyDraft,
  updateModelCredentialDraft,
} from './modelCredentialCommands'

export {
  configureModelEndpointHost,
  deleteModelEndpoint,
  hydrateModelEndpoint,
  saveModelEndpoint,
  updateModelEndpointDraft,
} from './modelEndpointCommands'

export {
  closeSettingsCenter,
  openSettingsCenter,
  selectSettingsTab,
} from './settingsCenterCommands'

let activeStorage = createBrowserAppSettingsStorage()

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '应用设置保存失败'
}

export function configureAppSettingsStorage(
  storage: AppSettingsStorage,
): void {
  activeStorage = storage
}

export async function hydrateAppSettings(): Promise<void> {
  const current = uiStore.getter(customInstructionsStatusAtom)
  if (current.status !== 'idle') return

  uiStore.setter(customInstructionsStatusAtom, { status: 'loading' })
  try {
    const settings = activeStorage.load()
    const customInstructions = settings.agent.customInstructions
    uiStore.setter(appSettingsAtom, settings)
    uiStore.setter(
      disabledProjectSkillsByWorkspaceAtom,
      settings.agent.disabledProjectSkills,
    )
    uiStore.setter(customInstructionsDraftAtom, customInstructions)
    synchronizeDefaultModelConnectionRuntime()
    configureCommands({
      customInstructions,
      modelUserId: settings.installationId,
    })
    uiStore.setter(customInstructionsStatusAtom, { status: 'ready' })
  } catch (error) {
    uiStore.setter(customInstructionsAtom, '')
    uiStore.setter(customInstructionsDraftAtom, '')
    // 这一个是 **core 的 root atom**（工作区级 Skills 禁用偏好，进持久化），不是界面态。
    rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {})
    configureCommands({
      customInstructions: '',
      modelUserId: undefined,
    })
    synchronizeDefaultModelConnectionRuntime()
    uiStore.setter(customInstructionsStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
  }

  await hydrateModelCredentials()
}

/** Persists a complete non-secret settings snapshot before publishing it to the UI. */
export function saveAppSettings(settings: AppSettings): void {
  activeStorage.save(settings)
  uiStore.setter(appSettingsAtom, settings)
}

/** Selects a third-party connection for future `newSession()` calls only. */
export function setDefaultModelConnection(connection: DefaultModelConnection): void {
  const selected = sanitizeDefaultModelConnection(connection)
  if (selected === undefined) throw new Error('默认模型连接格式无效')
  const settings = uiStore.getter(appSettingsAtom)
  saveAppSettings({ ...settings, defaultModelConnection: selected })
  synchronizeDefaultModelConnectionRuntime()
}

/** Restores the built-in model default for future `newSession()` calls only. */
export function clearDefaultModelConnection(): void {
  const settings = uiStore.getter(appSettingsAtom)
  if (settings.defaultModelConnection === undefined) {
    synchronizeDefaultModelConnectionRuntime()
    return
  }
  const { defaultModelConnection: _defaultModelConnection, ...withoutDefault } = settings
  saveAppSettings(withoutDefault)
  synchronizeDefaultModelConnectionRuntime()
}

/** Clears the selection only when a later profile deletion targets its stable ID. */
export function clearDefaultModelConnectionIfMatching(id: string): boolean {
  const selected = uiStore.getter(appSettingsAtom).defaultModelConnection
  if (selected?.id !== id.trim()) return false
  clearDefaultModelConnection()
  return true
}

export function updateCustomInstructionsDraft(value: string): void {
  uiStore.setter(
    customInstructionsDraftAtom,
    value.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH),
  )
  uiStore.setter(customInstructionsStatusAtom, { status: 'ready' })
}

export function saveCustomInstructions(): boolean {
  const value = uiStore.getter(customInstructionsDraftAtom).trim()
  try {
    const settings = uiStore.getter(appSettingsAtom)
    activeStorage.save({
      ...settings,
      agent: {
        ...settings.agent,
        customInstructions: value,
      },
    })
    uiStore.setter(customInstructionsAtom, value)
    uiStore.setter(customInstructionsDraftAtom, value)
    configureCommands({ customInstructions: value })
    uiStore.setter(customInstructionsStatusAtom, { status: 'saved' })
    return true
  } catch (error) {
    uiStore.setter(customInstructionsStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
    return false
  }
}
