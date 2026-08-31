/** Host command argument contract for OpenAI-compatible connection profile CRUD. */
import type { ConnectionProfileModel } from './connectionProfile'

export interface ConnectionProfileCommandArgs {
  model_connection_profile_list: undefined
  model_connection_profile_read: { id: string }
  model_connection_profile_save: {
    input: {
      id: string
      label: string
      baseUrl: string
      models: readonly ConnectionProfileModel[]
      /** Write-only. Omission preserves an existing credential. */
      apiKey?: string
    }
  }
  model_connection_profile_delete: { id: string }
}
