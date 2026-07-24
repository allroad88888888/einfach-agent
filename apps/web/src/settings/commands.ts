import { configureCommands } from '@web-agent/core/runtime/commands'
import { rootStore } from '@web-agent/core/state/rootStore'
import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MODEL_API_KEY_LENGTH,
  sanitizeModelApiKey,
} from './config'
import {
  createBrowserAppSettingsStorage,
  type AppSettingsStorage,
} from './persistence'
import {
  appSettingsAtom,
  customInstructionsAtom,
  customInstructionsDraftAtom,
  customInstructionsStatusAtom,
  deepSeekApiKeyAtom,
  deepSeekApiKeyDraftAtom,
  deepSeekApiKeyStatusAtom,
} from './state'

let activeStorage = createBrowserAppSettingsStorage()
let environmentDeepSeekApiKey = ''

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

export function configureAppSettingsEnvironment(config: {
  deepseekApiKey?: string
}): void {
  environmentDeepSeekApiKey = sanitizeModelApiKey(config.deepseekApiKey ?? '').trim()
  if (!rootStore.getter(deepSeekApiKeyAtom)) {
    configureCommands({ deepseekApiKey: environmentDeepSeekApiKey })
  }
}

export function hydrateAppSettings(): void {
  const current = rootStore.getter(customInstructionsStatusAtom)
  if (current.status !== 'idle') return

  rootStore.setter(customInstructionsStatusAtom, { status: 'loading' })
  rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'loading' })
  try {
    const settings = activeStorage.load()
    const customInstructions = settings.agent.customInstructions
    const deepseekApiKey = settings.providers.deepseek.apiKey
    rootStore.setter(appSettingsAtom, settings)
    rootStore.setter(customInstructionsDraftAtom, customInstructions)
    rootStore.setter(deepSeekApiKeyDraftAtom, deepseekApiKey)
    configureCommands({
      customInstructions,
      deepseekApiKey: deepseekApiKey || environmentDeepSeekApiKey,
      deepseekUserId: settings.installationId,
    })
    rootStore.setter(customInstructionsStatusAtom, { status: 'ready' })
    rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'ready' })
  } catch (error) {
    rootStore.setter(customInstructionsAtom, '')
    rootStore.setter(customInstructionsDraftAtom, '')
    rootStore.setter(deepSeekApiKeyAtom, '')
    rootStore.setter(deepSeekApiKeyDraftAtom, '')
    configureCommands({
      customInstructions: '',
      deepseekApiKey: environmentDeepSeekApiKey,
      deepseekUserId: undefined,
    })
    const status = {
      status: 'error',
      error: errorMessage(error),
    } as const
    rootStore.setter(customInstructionsStatusAtom, status)
    rootStore.setter(deepSeekApiKeyStatusAtom, status)
  }
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

export function updateDeepSeekApiKeyDraft(value: string): void {
  rootStore.setter(
    deepSeekApiKeyDraftAtom,
    value.slice(0, MAX_MODEL_API_KEY_LENGTH),
  )
  rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'ready' })
}

export function saveDeepSeekApiKey(): boolean {
  const value = rootStore.getter(deepSeekApiKeyDraftAtom).trim()
  try {
    const settings = rootStore.getter(appSettingsAtom)
    activeStorage.save({
      ...settings,
      providers: {
        ...settings.providers,
        deepseek: {
          ...settings.providers.deepseek,
          apiKey: value,
        },
      },
    })
    rootStore.setter(deepSeekApiKeyAtom, value)
    rootStore.setter(deepSeekApiKeyDraftAtom, value)
    configureCommands({
      deepseekApiKey: value || environmentDeepSeekApiKey,
    })
    rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'saved' })
    return true
  } catch (error) {
    rootStore.setter(deepSeekApiKeyStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
    return false
  }
}
