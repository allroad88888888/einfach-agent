import type { ModelItem } from '@web-agent/ai'
import type { CoreInstance } from '../runtime/core/coreInstance'
import { SubagentArchiveWriter } from './archiveWriter'
import { ROOT_AGENT_PATH } from './path'
import {
  renderJsonDocument,
  renderJsonLine,
  renderNodeRecord,
  renderSkillMarkdown,
  renderTreeSnapshot,
  subagentConversationPath,
  subagentEventsPath,
  subagentIndexPath,
  subagentNodePath,
  subagentRunPath,
  subagentTracePath,
  subagentTreePath,
} from './skillCache'
import type {
  DelegateAgentCallContext,
  SubagentArchiveEvent,
  SubagentArchiveEventType,
  SubagentArchiveWriteMode,
  SubagentNodeRecord,
  SubagentSkillFile,
} from './types'

interface SubagentArchiveIOOptions {
  core?: CoreInstance
  sessionId: string
  runId: string
  model: string
  vendor: string
  onTraceItem?(input: {
    agentPath: string
    timestamp: string
    turn: number
    item: ModelItem
  }): void
}

function compactIndexText(value: string, limit = 500): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...[truncated]` : trimmed
}

function skillIndexRecord(skill: SubagentSkillFile): Record<string, unknown> {
  return {
    type: 'skill',
    skillId: skill.skillId,
    conversationId: skill.conversationId,
    runId: skill.runId,
    agentPath: skill.agentPath,
    kind: skill.kind,
    filename: skill.filename,
    path: skill.path,
    globalPath: skill.globalPath,
    contentHash: skill.contentHash,
    promotion: skill.promotion,
    ttl: skill.ttl,
    inheritSkillIds: skill.inheritSkillIds,
    sourceTranscriptChars: skill.source.transcriptChars,
    createdAt: skill.createdAt,
    summary: compactIndexText(skill.content),
  }
}

function nodeIndexRecord(node: SubagentNodeRecord): Record<string, unknown> {
  return {
    type: 'agent_node',
    id: node.id,
    conversationId: node.sessionId,
    runId: node.treeId,
    path: node.path,
    parentPath: node.parentPath,
    status: node.status,
    objective: node.objective,
    depth: node.depth,
    inheritedSkillIds: node.inheritedSkillIds,
    localSkillIds: node.localSkillIds,
    resultFile: node.resultFile,
    error: node.error,
    updatedAt: node.updatedAt,
  }
}

/** Persists one delegate runtime's archive documents, events, traces, and indexes. */
export class SubagentArchiveIO {
  private readonly writer: SubagentArchiveWriter
  private readonly batchedIndexPaths = new Set([
    subagentIndexPath('runs'),
    subagentIndexPath('skills'),
    subagentIndexPath('agents'),
  ])
  private readonly startedAt = new Date().toISOString()
  private initialized = false
  private initialization: Promise<void> | undefined
  private eventCounter = 0

  constructor(private readonly options: SubagentArchiveIOOptions) {
    this.writer = new SubagentArchiveWriter(options.core, { sessionId: options.sessionId, runId: options.runId, vendor: options.vendor, model: options.model })
  }

  close(): Promise<void> {
    return this.writer.close()
  }

  async writeText(
    context: DelegateAgentCallContext,
    path: string,
    content: string,
    mode: SubagentArchiveWriteMode = 'overwrite',
  ): Promise<void> {
    if (!context.writeTextFile) return
    await this.writer.write(
      { path, content, mode },
      async (input) => {
        const result = await context.writeTextFile!(input)
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          const error = 'error' in result ? String(result.error) : 'unknown write error'
          throw new Error(`failed to write subagent archive ${input.path}: ${error}`)
        }
      },
      { batchAppend: mode === 'append' && this.batchedIndexPaths.has(path) },
    )
  }

  async writeRunArchiveRecord(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    status: 'running' | 'delegated',
    appendIndex: boolean,
  ): Promise<void> {
    const record = this.runArchiveRecord(archiveBasePath, status)
    await this.writeText(context, subagentRunPath(archiveBasePath), renderJsonDocument(record))
    if (appendIndex) {
      await this.writeText(context, subagentIndexPath('runs'), renderJsonLine(record), 'append')
    }
  }

  async ensureArchiveInitialized(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
  ): Promise<void> {
    if (this.initialized) return
    if (!this.initialization) {
      this.initialization = (async () => {
        const now = new Date().toISOString()
        await Promise.all([
          this.writeText(
            context,
            subagentConversationPath(this.options.sessionId),
            renderJsonDocument({
              archiveVersion: 1,
              conversationId: this.options.sessionId,
              updatedAt: now,
            }),
          ),
          this.writeRunArchiveRecord(context, archiveBasePath, 'running', true),
        ])
        await this.recordEvent(context, archiveBasePath, 'archive_initialized', ROOT_AGENT_PATH, {
          archiveBasePath,
          eventLog: subagentEventsPath(archiveBasePath),
        })
        this.initialized = true
      })()
    }
    try {
      await this.initialization
    } finally {
      if (!this.initialized) this.initialization = undefined
    }
  }

  async recordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    this.eventCounter += 1
    const event: SubagentArchiveEvent = {
      eventId: `${this.options.runId}:evt-${String(this.eventCounter).padStart(4, '0')}`,
      type,
      timestamp: new Date().toISOString(),
      conversationId: this.options.sessionId,
      runId: this.options.runId,
      treeId: this.options.runId,
      agentPath,
      data,
    }
    await this.writeText(context, subagentEventsPath(archiveBasePath), renderJsonLine(event), 'append')
  }

  async bestEffortRecordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.recordEvent(context, archiveBasePath, type, agentPath, data)
    } catch {
      // A cancelled/stale host may reject archive writes. Preserve the original runtime outcome.
    }
  }

  async bestEffortRecordTraceItem(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    agentPath: string,
    turn: number,
    item: ModelItem,
  ): Promise<void> {
    const timestamp = new Date().toISOString()
    this.options.onTraceItem?.({ agentPath, timestamp, turn, item })
    try {
      await this.writeText(
        context,
        subagentTracePath(archiveBasePath, agentPath),
        renderJsonLine({ timestamp, turn, item }),
        'append',
      )
    } catch {
      // 轨迹用于可观测性；归档失败不能覆盖子 agent 原本的执行结果。
    }
  }

  async persistSkill(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    skill: SubagentSkillFile,
  ): Promise<void> {
    const content = renderSkillMarkdown(skill)
    await Promise.all([
      this.writeText(context, skill.path, content),
      this.writeText(context, skill.globalPath, content),
      this.writeText(context, subagentIndexPath('skills'), renderJsonLine(skillIndexRecord(skill)), 'append'),
    ])
    await this.recordEvent(context, archiveBasePath, 'skill_written', skill.agentPath, {
      skillId: skill.skillId,
      kind: skill.kind,
      path: skill.path,
      globalPath: skill.globalPath,
      contentHash: skill.contentHash,
      promotion: skill.promotion,
    })
  }

  async persistTreeSnapshot(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    nodes: SubagentNodeRecord[],
  ): Promise<void> {
    await this.writeText(context, subagentTreePath(archiveBasePath), renderTreeSnapshot(nodes))
    await Promise.all(
      nodes.map((node) => this.writeText(
        context,
        subagentNodePath(archiveBasePath, node.path),
        renderNodeRecord(node),
      )),
    )
    await Promise.all(
      nodes.map((node) => this.writeText(
        context,
        subagentIndexPath('agents'),
        renderJsonLine(nodeIndexRecord(node)),
        'append',
      )),
    )
    await this.recordEvent(context, archiveBasePath, 'tree_snapshot_written', ROOT_AGENT_PATH, {
      nodes: nodes.length,
      treePath: subagentTreePath(archiveBasePath),
    })
  }

  private runArchiveRecord(
    archiveBasePath: string,
    status: 'running' | 'delegated',
  ): Record<string, unknown> {
    return {
      archiveVersion: 1,
      conversationId: this.options.sessionId,
      runId: this.options.runId,
      treeId: this.options.runId,
      status,
      model: this.options.model,
      vendor: this.options.vendor,
      archiveBasePath,
      eventLog: subagentEventsPath(archiveBasePath),
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
    }
  }
}
