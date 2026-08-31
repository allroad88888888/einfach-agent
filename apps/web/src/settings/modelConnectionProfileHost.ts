/** The public, non-secret portion of one OpenAI-compatible model connection. */
export interface ModelConnectionProfile {
  id: string
  label: string
  kind: 'openai-compatible'
  baseUrl: string
  models: readonly ConnectionProfileModel[]
  credentialConfigured: boolean
}

export interface ConnectionProfileModel {
  id: string
  label: string
  source: 'manual' | 'discovered'
}

/** `apiKey` is write-only: hosts must never include it in a response. */
export interface ModelConnectionProfileSaveInput {
  id: string
  label: string
  baseUrl: string
  models: readonly ConnectionProfileModel[]
  apiKey?: string
}

export interface ModelConnectionProfileProbeResult {
  readonly models: readonly ConnectionProfileModel[]
}

export interface ModelConnectionProfileHost {
  available: boolean
  list(): Promise<readonly ModelConnectionProfile[]>
  read(id: string): Promise<ModelConnectionProfile | null>
  save(input: ModelConnectionProfileSaveInput): Promise<ModelConnectionProfile>
  delete(id: string): Promise<{ deleted: boolean }>
  probe(input: { baseUrl: string; apiKey?: string }): Promise<ModelConnectionProfileProbeResult>
}

/** Static deployments cannot persist or use third-party OpenAI-compatible connections. */
export function createUnavailableModelConnectionProfileHost(): ModelConnectionProfileHost {
  const unavailable = async (): Promise<never> => {
    throw new Error('模型连接只能由本机后端写入配置文件；当前页面没有连上本机后端。')
  }
  return {
    available: false,
    list: async () => [],
    read: unavailable,
    save: unavailable,
    delete: unavailable,
    probe: unavailable,
  }
}
