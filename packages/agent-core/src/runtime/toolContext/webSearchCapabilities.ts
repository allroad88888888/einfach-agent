import type { ToolContext } from '../../tools/context'
import type { WebSearchCapability } from '../../tools/webSearch'
import type { ToolStaleGuards } from './staleGuards'

/** Exposes web search only while the calling run is current. */
export function createWebSearchCapabilities(deps: {
  capability?: WebSearchCapability
  signal: AbortSignal
  guards: ToolStaleGuards
}): Pick<ToolContext, 'webSearch'> {
  const { capability, signal, guards } = deps
  if (!capability) return {}
  return {
    async webSearch(input) {
      guards.assertFresh()
      const result = await capability(input, { signal })
      guards.assertFresh()
      return result
    },
  }
}
