// runtime/toolContext/outputCapabilities.ts —— ctx 上的会话瞬态产出：信息卡片与待保存产物。
// 两个入口都不抛错，stale（已取消 / 被新 run 顶掉）时回 { error: 'stale' }；守卫判断逐字沿用
// 拆分前 buildToolContext 里的内联实现。

import type { ToolContext } from '../../tools/types'
import { addBrowserCard, addPendingArtifact } from '../../state/transientAtoms'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { isCurrentRun, type CurrentRunDeps } from '../shared/runGuards'

export type OutputCapabilities = Pick<ToolContext, 'renderCard' | 'saveArtifact'>

export function createOutputCapabilities(deps: {
  sessionId: string
  signal: AbortSignal
  currentRun: CurrentRunDeps
  core: CoreInstance
}): OutputCapabilities {
  const { sessionId, signal, currentRun, core } = deps

  return {
    renderCard(card) {
      if (signal.aborted || !isCurrentRun(currentRun)) return { error: 'stale' }
      const cardId = newId()
      addBrowserCard(sessionId, { id: cardId, createdAt: Date.now(), title: card.title, body: card.body }, core)
      return { cardId }
    },

    saveArtifact(file) {
      if (signal.aborted || !isCurrentRun(currentRun)) return { error: 'stale' }
      const artifactId = newId()
      addPendingArtifact(sessionId, {
        id: artifactId,
        filename: file.filename,
        content: file.content,
        mimeType: file.mimeType,
      }, core)
      return { artifactId }
    },
  }
}
