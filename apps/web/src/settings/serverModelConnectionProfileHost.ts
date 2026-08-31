import type { HostInvoke } from '@einfach-agent/core'
import { httpInvoke } from '../host/serverInvoke'
import type {
  ModelConnectionProfile,
  ModelConnectionProfileHost,
  ModelConnectionProfileProbeResult,
  ModelConnectionProfileSaveInput,
} from './modelConnectionProfileHost'

/** Creates the server-only adapter for public connection-profile metadata CRUD. */
export function createServerModelConnectionProfileHost(
  invoke: HostInvoke = httpInvoke,
): ModelConnectionProfileHost {
  return {
    available: true,
    list: () => invoke<readonly ModelConnectionProfile[]>('model_connection_profile_list'),
    read: (id: string) => invoke<ModelConnectionProfile | null>(
      'model_connection_profile_read',
      { id },
    ),
    save: (input: ModelConnectionProfileSaveInput) => invoke<ModelConnectionProfile>(
      'model_connection_profile_save',
      { input },
    ),
    delete: (id: string) => invoke<{ deleted: boolean }>(
      'model_connection_profile_delete',
      { id },
    ),
    probe: (input) => invoke<ModelConnectionProfileProbeResult>(
      'model_connection_profile_probe',
      { input },
    ),
  }
}
