// core 内核测试用的内存归档端口。
// ---------------------------------------------------------------------------
// 所有写入都过调用方给的 `writeTextFile`，测试据此从一张 Map 里读回 events/tree/results/skills。
// 只保留内核断言真正依赖的语义：事件按 JSONL 追加、写失败要抛（不能被吞，否则「归档失败中止
// 本批」无从断言）、best-effort 系列不改写执行结局。产品归档的批量索引、初始化重试、目录布局
// 与内容哈希不在这里复制——那些是 `packages/subagents` 的标的。

import type { ModelItem } from '@web-agent/ai'
import type { DelegationArchiveFormatPort, SubagentArchivePort } from './delegationRuntimePorts'
import { formatSubagentTranscript } from '../runtime/subagentTranscript'
import { ROOT_AGENT_PATH } from './path'
import type {
  DelegateAgentCallContext,
  SubagentArchiveEventType,
  SubagentArchiveWriteMode,
} from './types'

/** 测试归档目录布局：够被 `endsWith('/events.jsonl')` 这类断言认出来即可。 */
export const testArchiveFormat: DelegationArchiveFormatPort = {
  cacheBasePath: (sessionId, runId) => `.webAgent-archive/test/${sessionId}/${runId}`,
  eventsPath: (basePath) => `${basePath}/events.jsonl`,
  resultPath: (basePath, agentPath) => `${basePath}/results/${agentPath}.result.md`,
  formatParentTranscript: (messages) => formatSubagentTranscript(messages),
}

export function createTestArchive(options: {
  sessionId: string
  runId: string
  onTraceItem?(input: { agentPath: string; timestamp: string; turn: number; item: ModelItem }): void
}): SubagentArchivePort {
  let eventCounter = 0
  let initialized = false

  async function writeText(
    context: DelegateAgentCallContext,
    path: string,
    content: string,
    mode: SubagentArchiveWriteMode = 'overwrite',
  ): Promise<void> {
    if (!context.writeTextFile) return
    const result = await context.writeTextFile({ path, content, mode })
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      const error = 'error' in result ? String(result.error) : 'unknown write error'
      throw new Error(`failed to write subagent archive ${path}: ${error}`)
    }
  }

  async function recordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    eventCounter += 1
    const event = {
      eventId: `${options.runId}:evt-${String(eventCounter).padStart(4, '0')}`,
      type,
      timestamp: new Date().toISOString(),
      conversationId: options.sessionId,
      runId: options.runId,
      treeId: options.runId,
      agentPath,
      data,
    }
    await writeText(
      context,
      testArchiveFormat.eventsPath(archiveBasePath),
      `${JSON.stringify(event)}\n`,
      'append',
    )
  }

  return {
    close() {},
    writeText,
    recordEvent,
    async writeRunArchiveRecord(context, archiveBasePath, status) {
      const record = {
        conversationId: options.sessionId,
        runId: options.runId,
        status,
        archiveBasePath,
        updatedAt: new Date().toISOString(),
      }
      await writeText(context, `${archiveBasePath}/run.json`, `${JSON.stringify(record, null, 2)}\n`)
    },
    async ensureArchiveInitialized(context, archiveBasePath) {
      if (initialized) return
      await recordEvent(context, archiveBasePath, 'archive_initialized', ROOT_AGENT_PATH, {
        archiveBasePath,
        eventLog: testArchiveFormat.eventsPath(archiveBasePath),
      })
      initialized = true
    },
    async bestEffortRecordEvent(context, archiveBasePath, type, agentPath, data) {
      try {
        await recordEvent(context, archiveBasePath, type, agentPath, data)
      } catch {
        // 归档失败不得改写子 agent 已经判定的执行结局。
      }
    },
    async bestEffortRecordTraceItem(context, archiveBasePath, agentPath, turn, item) {
      const timestamp = new Date().toISOString()
      options.onTraceItem?.({ agentPath, timestamp, turn, item })
      try {
        await writeText(
          context,
          `${archiveBasePath}/traces/${agentPath}.trace.jsonl`,
          `${JSON.stringify({ timestamp, turn, item })}\n`,
          'append',
        )
      } catch {
        // 同上：轨迹只用于可观测性。
      }
    },
    async persistSkill(context, archiveBasePath, skill) {
      await writeText(context, skill.path, skill.content)
      await recordEvent(context, archiveBasePath, 'skill_written', skill.agentPath, {
        skillId: skill.skillId,
        kind: skill.kind,
        path: skill.path,
      })
    },
    async persistTreeSnapshot(context, archiveBasePath, nodes) {
      await writeText(
        context,
        `${archiveBasePath}/tree.json`,
        `${JSON.stringify({ nodes }, null, 2)}\n`,
      )
      await recordEvent(context, archiveBasePath, 'tree_snapshot_written', ROOT_AGENT_PATH, {
        nodes: nodes.length,
      })
    },
  }
}
