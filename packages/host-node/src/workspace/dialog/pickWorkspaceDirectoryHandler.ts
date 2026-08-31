import { pickNativeWorkspaceDirectory } from './nativeDirectoryPicker'
import type { NodeHostInvokeOptions } from '../../hostOptions'

export interface PickWorkspaceDirectoryResponse {
  path: string | null
}

/** Returns the one user-chosen directory, or null when the system dialog is cancelled. */
export function createPickWorkspaceDirectoryHandler(options: NodeHostInvokeOptions) {
  const pickDirectory = options.openWorkspaceDirectory ?? pickNativeWorkspaceDirectory
  return async (_args: Record<string, unknown>): Promise<PickWorkspaceDirectoryResponse> => ({
    path: (await pickDirectory()) ?? null,
  })
}
