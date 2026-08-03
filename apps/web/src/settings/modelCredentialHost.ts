import { invoke } from '@tauri-apps/api/core'

export type CredentialSource = 'keychain' | 'environment' | 'missing'

export interface ModelCredentialStatus {
  configured: boolean
  source: CredentialSource
}

export interface ModelCredentialHost {
  deepSeekStatus(): Promise<ModelCredentialStatus>
  saveDeepSeek(apiKey: string): Promise<ModelCredentialStatus>
  deleteDeepSeek(): Promise<ModelCredentialStatus>
}

export function createUnavailableModelCredentialHost(): ModelCredentialHost {
  const unavailable = async (): Promise<ModelCredentialStatus> => {
    throw new Error('模型密钥只能在桌面应用中保存。')
  }
  return {
    deepSeekStatus: async () => ({ configured: false, source: 'missing' }),
    saveDeepSeek: unavailable,
    deleteDeepSeek: unavailable,
  }
}

/** Uses desktop IPC commands whose responses never contain a credential value. */
export function createTauriModelCredentialHost(): ModelCredentialHost {
  return {
    deepSeekStatus: () => invoke<ModelCredentialStatus>('model_credential_status', {
      provider: 'deepseek',
    }),
    saveDeepSeek: (apiKey) => invoke<ModelCredentialStatus>('model_credential_set', {
      input: { provider: 'deepseek', apiKey },
    }),
    deleteDeepSeek: () => invoke<ModelCredentialStatus>('model_credential_delete', {
      provider: 'deepseek',
    }),
  }
}
