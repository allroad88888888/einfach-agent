import { createPickWorkspaceDirectoryHandler } from './pickWorkspaceDirectoryHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

/** Registers the single user-initiated workspace directory chooser command. */
export function createWorkspaceDialogRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return { pick_workspace_directory: createPickWorkspaceDirectoryHandler(options) }
}
