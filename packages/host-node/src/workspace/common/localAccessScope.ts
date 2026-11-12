// Each host invocation owns its access scope. AsyncLocalStorage keeps concurrent
// sessions isolated without changing the workspace used by journals or Git.
import { AsyncLocalStorage } from 'node:async_hooks'
import { isWithinRoot } from './pathContainment'

const fullAccess = new AsyncLocalStorage<boolean>()
const mutableFileCommands = new Set([
  'write_workspace_file', 'apply_workspace_patch', 'delete_workspace_path',
  'copy_workspace_path', 'move_workspace_path', 'revert_workspace_change',
])

export function withLocalAccessScope<T>(
  command: string,
  args: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const allowed = mutableFileCommands.has(command) && args.full_local_access === true
  return fullAccess.run(allowed, operation)
}

export function hasFullLocalAccess(): boolean {
  return fullAccess.getStore() === true
}

export function canAccessWorkspacePath(root: string, path: string): boolean {
  return hasFullLocalAccess() || isWithinRoot(root, path)
}
