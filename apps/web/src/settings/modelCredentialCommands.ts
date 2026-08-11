import { rootStore } from '@web-agent/core/state/rootStore'
import {
  createUnavailableModelCredentialHost,
  MODEL_CREDENTIALS,
  type ModelCredentialHost,
  type ModelCredentialId,
} from './modelCredentialHost'
import {
  modelCredentialHostAvailableAtom,
  modelCredentialEntriesAtom,
  setModelCredentialDraft,
  setModelCredentialStatus,
} from './modelCredentialState'

let activeHost = createUnavailableModelCredentialHost()

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '模型密钥操作失败'
}

function saveVerificationError(label: string): string {
  return `未能确认 ${label} API Key 已保存，请重试。`
}

function hydrationStatusError(label: string): string {
  return `无法读取 ${label} API Key 状态，请重试。`
}

function descriptor(id: ModelCredentialId) {
  const value = MODEL_CREDENTIALS.find((candidate) => candidate.id === id)
  if (!value) throw new Error(`未知模型凭据：${id}`)
  return value
}

export function configureModelCredentialHost(host: ModelCredentialHost): void {
  activeHost = host
  rootStore.setter(modelCredentialHostAvailableAtom, host.available)
}

export async function hydrateModelCredentials(): Promise<void> {
  await Promise.all(MODEL_CREDENTIALS.map(async ({ id, label, target }) => {
    setModelCredentialStatus(rootStore, id, {
      status: 'loading', configured: false, source: 'missing',
    })
    try {
      const credential = await activeHost.status(target)
      setModelCredentialStatus(rootStore, id, { status: 'ready', ...credential })
    } catch {
      setModelCredentialStatus(rootStore, id, {
        status: 'error',
        error: hydrationStatusError(label),
        configured: false,
        source: 'missing',
      })
    }
  }))
}

export function updateModelCredentialDraft(id: ModelCredentialId, value: string): void {
  setModelCredentialDraft(rootStore, id, value)
  const state = rootStore.getter(modelCredentialEntriesAtom)[id].state
  setModelCredentialStatus(rootStore, id, {
    status: 'ready',
    configured: state.configured,
    source: state.source,
  })
}

export async function saveModelCredential(id: ModelCredentialId): Promise<boolean> {
  const { label, target } = descriptor(id)
  const value = rootStore.getter(modelCredentialEntriesAtom)[id].draft.trim()
  if (!value) {
    setModelCredentialStatus(rootStore, id, {
      status: 'error',
      error: `请输入 ${label} API Key。`,
      configured: false,
      source: 'missing',
    })
    return false
  }
  setModelCredentialStatus(rootStore, id, {
    status: 'loading', configured: false, source: 'missing',
  })
  try {
    await activeHost.save(target, value)
    const credential = await activeHost.status(target)
    if (!credential.configured) {
      setModelCredentialStatus(rootStore, id, {
        status: 'error',
        error: saveVerificationError(label),
        configured: false,
        source: 'missing',
      })
      return false
    }
    setModelCredentialDraft(rootStore, id, '')
    setModelCredentialStatus(rootStore, id, { status: 'saved', ...credential })
    return true
  } catch {
    setModelCredentialStatus(rootStore, id, {
      status: 'error',
      error: saveVerificationError(label),
      configured: false,
      source: 'missing',
    })
    return false
  }
}

export async function deleteModelCredential(id: ModelCredentialId): Promise<boolean> {
  const { target } = descriptor(id)
  setModelCredentialStatus(rootStore, id, {
    status: 'loading', configured: false, source: 'missing',
  })
  try {
    const credential = await activeHost.delete(target)
    setModelCredentialDraft(rootStore, id, '')
    setModelCredentialStatus(rootStore, id, { status: 'saved', ...credential })
    return true
  } catch (error) {
    setModelCredentialStatus(rootStore, id, {
      status: 'error',
      error: errorMessage(error),
      configured: false,
      source: 'missing',
    })
    return false
  }
}

export const updateDeepSeekApiKeyDraft = (value: string) => (
  updateModelCredentialDraft('deepseek-default', value)
)
export const saveDeepSeekApiKey = () => saveModelCredential('deepseek-default')
export const deleteDeepSeekApiKey = () => deleteModelCredential('deepseek-default')
export const updateKimiApiKeyDraft = (value: string) => (
  updateModelCredentialDraft('kimi-cn', value)
)
export const saveKimiApiKey = () => saveModelCredential('kimi-cn')
export const deleteKimiApiKey = () => deleteModelCredential('kimi-cn')
