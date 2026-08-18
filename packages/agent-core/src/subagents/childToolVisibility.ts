import type { LoadedTool } from '../tools/types'
import { DelegateAgentRuntimeState } from './runtimeState'

/** Resolves child-visible schemas and excludes native server tools in Web. */
/** Returns a schema only when the current child runtime may expose its execution host. */
export function loadVisibleChildTool(
  name: string,
  runtime: DelegateAgentRuntimeState,
): LoadedTool | undefined {
  const tool = runtime.registry.loadSchema(name)
  return tool && (tool.runtime !== 'server' || runtime.opts.hostHasLocalCapabilities === true) ? tool : undefined
}

/** Adds or refreshes one schema in the bounded child-visible tool working set. */
export function appendVisibleChildTool(
  current: LoadedTool[],
  name: string,
  runtime: DelegateAgentRuntimeState,
  maxLoadedTools: number,
): LoadedTool[] {
  const tool = loadVisibleChildTool(name, runtime)
  if (!tool) return current.filter((loaded) => loaded.name !== name)
  const existing = current.find((loaded) => loaded.name === name)
  const snapshot = existing && existing.registrationVersion === tool.registrationVersion ? existing : tool
  const visible = [...current.filter((loaded) => loaded.name !== name), snapshot]
  return maxLoadedTools > 0 ? visible.slice(-maxLoadedTools) : []
}
