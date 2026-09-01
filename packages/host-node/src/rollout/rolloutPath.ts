import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { AgentHistoryTarget } from '@einfach-agent/core/history'

export interface RolloutHistoryPath {
  readonly filePath: string
  readonly historyId: string
}

function key(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Maps a logical history target to an application-owned, portable JSONL path. */
export function resolveRolloutHistoryPath(appDataDirectory: string, target: AgentHistoryTarget): RolloutHistoryPath {
  const conversationKey = key(target.conversationId)
  if (target.kind === 'root') {
    return {
      filePath: join(appDataDirectory, 'rollouts', 'conversations', conversationKey, 'root.jsonl'),
      historyId: `root:${conversationKey}`,
    }
  }

  const runKey = key(target.runId)
  const agentKey = key(target.agentPath)
  return {
    filePath: join(
      appDataDirectory,
      'rollouts',
      'conversations',
      conversationKey,
      'runs',
      runKey,
      'agents',
      `${agentKey}.jsonl`,
    ),
    historyId: `child:${conversationKey}:${runKey}:${agentKey}`,
  }
}
