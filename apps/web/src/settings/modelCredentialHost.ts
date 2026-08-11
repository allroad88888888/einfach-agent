import { invoke } from '@tauri-apps/api/core'

export type CredentialSource = 'config' | 'missing'

export type ModelCredentialTarget =
  | { provider: 'deepseek'; scope: 'default' }
  | { provider: 'glm'; scope: 'default' }
  | { provider: 'kimi'; scope: 'cn' }

export type ModelCredentialId = 'deepseek-default' | 'glm-default' | 'kimi-cn'

export interface ModelCredentialDescriptor {
  id: ModelCredentialId
  label: string
  target: ModelCredentialTarget
}

export const MODEL_CREDENTIALS: readonly ModelCredentialDescriptor[] = [
  {
    id: 'deepseek-default',
    label: 'DeepSeek',
    target: { provider: 'deepseek', scope: 'default' },
  },
  {
    id: 'glm-default',
    label: 'GLM',
    target: { provider: 'glm', scope: 'default' },
  },
  {
    id: 'kimi-cn',
    label: 'Kimi 中国区',
    target: { provider: 'kimi', scope: 'cn' },
  },
]

export interface ModelCredentialStatus {
  configured: boolean
  source: CredentialSource
}

export interface ModelCredentialHost {
  available: boolean
  status(target: ModelCredentialTarget): Promise<ModelCredentialStatus>
  save(target: ModelCredentialTarget, apiKey: string): Promise<ModelCredentialStatus>
  delete(target: ModelCredentialTarget): Promise<ModelCredentialStatus>
}

export function createUnavailableModelCredentialHost(): ModelCredentialHost {
  const unavailable = async (): Promise<ModelCredentialStatus> => {
    throw new Error('模型密钥只能在桌面应用配置文件中保存。')
  }
  return {
    available: false,
    status: async () => ({ configured: false, source: 'missing' }),
    save: unavailable,
    delete: unavailable,
  }
}

/** Uses desktop IPC commands whose responses never contain a credential value. */
export function createTauriModelCredentialHost(): ModelCredentialHost {
  return {
    available: true,
    status: ({ provider, scope }) => invoke<ModelCredentialStatus>(
      'model_credential_status',
      { provider, scope },
    ),
    save: ({ provider, scope }, apiKey) => invoke<ModelCredentialStatus>(
      'model_credential_set',
      { input: { provider, scope, apiKey } },
    ),
    delete: ({ provider, scope }) => invoke<ModelCredentialStatus>(
      'model_credential_delete',
      { provider, scope },
    ),
  }
}
