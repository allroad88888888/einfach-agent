import { configureCommands } from '@web-agent/core/runtime/commands'
import { rootStore } from '@web-agent/core/state/rootStore'
import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MODEL_API_KEY_LENGTH,
} from './config'
import {
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
} from './modelCredentialHost'
import {
  createBrowserAppSettingsStorage,
  type AppSettingsStorage,
} from './persistence'
import {
  appSettingsAtom,
  customInstructionsAtom,
  customInstructionsDraftAtom,
  customInstructionsStatusAtom,
  deepSeekApiKeyDraftAtom,
  deepSeekApiKeyStatusAtom,
} from './state'

let activeStorage = createBrowserAppSettingsStorage()
let activeModelCredentialHost = createUnavailableModelCredentialHost()

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

export function configureModelCredentialHost(host: ModelCredentialHost): void {
  activeModelCredentialHost = host
}

export async function hydrateAppSettings(): Promise<void> {
  const current = rootStore.getter(customInstructionsStatusAtom)
  if (current.status !== 'idle') return

  rootStore.setter(customInstructionsStatusAtom, { status: 'loading' })
  rootStore.setter(deepSeekApiKeyStatusAtom, {
    status: 'loading', configured: false, source: 'missing',
  })
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
    rootStore.setter(deepSeekApiKeyDraftAtom, '')
    configureCommands({
      customInstructions: '',
      deepseekUserId: undefined,
    })
    rootStore.setter(customInstructionsStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
  }

  try {
    const credential = await activeModelCredentialHost.deepSeekStatus()
    rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'ready', ...credential })
  } catch (error) {
    rootStore.setter(deepSeekApiKeyStatusAtom, {
      status: 'error', error: errorMessage(error), configured: false, source: 'missing',
    })
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
  const status = rootStore.getter(deepSeekApiKeyStatusAtom)
  rootStore.setter(deepSeekApiKeyStatusAtom, {
    status: 'ready',
    configured: status.configured,
    source: status.source,
  })
}

export async function saveDeepSeekApiKey(): Promise<boolean> {
  const value = rootStore.getter(deepSeekApiKeyDraftAtom).trim()
  if (!value) {
    rootStore.setter(deepSeekApiKeyStatusAtom, {
      status: 'error', error: '请输入 DeepSeek API Key。', configured: false, source: 'missing',
    })
    return false
  }
  rootStore.setter(deepSeekApiKeyStatusAtom, {
    status: 'loading', configured: false, source: 'missing',
  })
  try {
    const credential = await activeModelCredentialHost.saveDeepSeek(value)
    rootStore.setter(deepSeekApiKeyDraftAtom, '')
    rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'saved', ...credential })
    return true
  } catch (error) {
    rootStore.setter(deepSeekApiKeyStatusAtom, {
      status: 'error',
      error: errorMessage(error),
      configured: false,
      source: 'missing',
    })
    return false
  }
}

export async function deleteDeepSeekApiKey(): Promise<boolean> {
  rootStore.setter(deepSeekApiKeyStatusAtom, {
    status: 'loading', configured: false, source: 'missing',
  })
  try {
    const credential = await activeModelCredentialHost.deleteDeepSeek()
    rootStore.setter(deepSeekApiKeyDraftAtom, '')
    rootStore.setter(deepSeekApiKeyStatusAtom, { status: 'saved', ...credential })
    return true
  } catch (error) {
    rootStore.setter(deepSeekApiKeyStatusAtom, {
      status: 'error', error: errorMessage(error), configured: false, source: 'missing',
    })
    return false
  }
}
