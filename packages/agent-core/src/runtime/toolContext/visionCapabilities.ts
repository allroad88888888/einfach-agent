import type {
  ToolContext,
  ViewImageCapability,
  WorkspaceImageReadResult,
} from '../../tools/types'
import type { ToolStaleGuards } from './staleGuards'
import { pathProgressText } from './progressReporting'

export type VisionCapabilities = Pick<ToolContext, 'viewImage'>

/** Safely exposes an app-owned vision port without granting it the full ToolContext. */
export function createVisionCapabilities(deps: {
  capability?: ViewImageCapability
  signal: AbortSignal
  readWorkspaceImage?: ToolContext['readWorkspaceImage']
  guards: ToolStaleGuards
  progress: ToolContext['progress']
}): VisionCapabilities {
  if (!deps.capability) return {}

  return {
    async viewImage(input) {
      deps.guards.assertFresh()
      deps.progress(pathProgressText('查看图片', input.path))
      const readWorkspaceImage = deps.readWorkspaceImage
      if (!readWorkspaceImage) {
        throw new Error('当前宿主不支持读取工作区图片，无法使用视觉能力')
      }
      const result = await deps.capability!(input, {
        signal: deps.signal,
        assertFresh: deps.guards.assertFresh,
        readWorkspaceImage: (readInput): Promise<WorkspaceImageReadResult> =>
          readWorkspaceImage(readInput),
      })
      deps.guards.assertFresh()
      return result
    },
  }
}
