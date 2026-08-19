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

/**
 * 没有本机后端的那一态（纯静态产物）：如实说存不进去，而不是给一个存不进去的框。
 * `available: false` 同时也是设置面板收起输入框、启动凭据门禁不开的判据。
 *
 * 【T1】文案从「只能在桌面应用配置文件中保存」改成按能力措辞：唯一能落盘的宿主现在是本机
 * Node 后端（`serverModelCredentialHost.ts`），报一个已经不存在的产品名等于对用户撒谎。
 */
export function createUnavailableModelCredentialHost(): ModelCredentialHost {
  const unavailable = async (): Promise<ModelCredentialStatus> => {
    throw new Error('模型密钥只能由本机后端写入配置文件；当前页面没有连上本机后端。')
  }
  return {
    available: false,
    status: async () => ({ configured: false, source: 'missing' }),
    save: unavailable,
    delete: unavailable,
  }
}
