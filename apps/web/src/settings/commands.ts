import { uiStore } from '../uiStore'
import { configureCommands, disabledProjectSkillsByWorkspaceAtom, rootStore } from '@einfach-agent/core'
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH, type AppSettings } from './config'
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
