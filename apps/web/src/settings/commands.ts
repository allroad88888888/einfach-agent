import { configureCommands } from '@web-agent/core/runtime/commands'
import { rootStore } from '@web-agent/core/state/rootStore'
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from './config'
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
  const current = rootStore.getter(customInstructionsStatusAtom)
  if (current.status !== 'idle') return

  rootStore.setter(customInstructionsStatusAtom, { status: 'loading' })
  try {
    const settings = activeStorage.load()
    const customInstructions = settings.agent.customInstructions
    rootStore.setter(appSettingsAtom, settings)
    rootStore.setter(customInstructionsDraftAtom, customInstructions)
    configureCommands({
      customInstructions,
      deepseekUserId: settings.installationId,
    })
    rootStore.setter(customInstructionsStatusAtom, { status: 'ready' })
  } catch (error) {
    rootStore.setter(customInstructionsAtom, '')
    rootStore.setter(customInstructionsDraftAtom, '')
    configureCommands({
      customInstructions: '',
      deepseekUserId: undefined,
    })
    rootStore.setter(customInstructionsStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
  }

  await hydrateModelCredentials()
}

export function updateCustomInstructionsDraft(value: string): void {
  rootStore.setter(
    customInstructionsDraftAtom,
    value.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH),
  )
  rootStore.setter(customInstructionsStatusAtom, { status: 'ready' })
}

export function saveCustomInstructions(): boolean {
  const value = rootStore.getter(customInstructionsDraftAtom).trim()
  try {
    const settings = rootStore.getter(appSettingsAtom)
    activeStorage.save({
      ...settings,
      agent: {
        ...settings.agent,
        customInstructions: value,
      },
    })
    rootStore.setter(customInstructionsAtom, value)
    rootStore.setter(customInstructionsDraftAtom, value)
    configureCommands({ customInstructions: value })
    rootStore.setter(customInstructionsStatusAtom, { status: 'saved' })
    return true
  } catch (error) {
    rootStore.setter(customInstructionsStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
    return false
  }
}
