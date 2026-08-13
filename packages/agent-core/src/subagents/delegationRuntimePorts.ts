import type { ModelItem } from '@web-agent/ai'
import type { SubagentScheduler } from '../runtime/delegationContract'
import type { SubagentTierRouting } from './tierRouting'
import type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentArchiveEventType,
  SubagentArchiveWriteMode,
  SubagentNodeRecord,
  SubagentSkillFile,
} from './types'

/** Function port used by child loops to create nested delegation batches. */
export type DelegateAgents = (
  rawInput: DelegateAgentInput,
  context: DelegateAgentCallContext,
) => Promise<DelegateAgentBatchResult>

/** Archive operations required by the child-run mechanism and product batch orchestrator. */
export interface SubagentArchivePort {
  close(): void | Promise<void>
  writeText(
    context: DelegateAgentCallContext,
    path: string,
    content: string,
    mode?: SubagentArchiveWriteMode,
  ): Promise<void>
  writeRunArchiveRecord(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    status: 'running' | 'delegated',
    appendIndex: boolean,
  ): Promise<void>
  ensureArchiveInitialized(context: DelegateAgentCallContext, archiveBasePath: string): Promise<void>
  recordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void>
  bestEffortRecordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void>
  bestEffortRecordTraceItem(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    agentPath: string,
    turn: number,
    item: ModelItem,
  ): Promise<void>
  persistSkill(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    skill: SubagentSkillFile,
  ): Promise<void>
  persistTreeSnapshot(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    nodes: SubagentNodeRecord[],
  ): Promise<void>
}

/** Product-owned archive path and transcript formatting functions used by child loops. */
export interface DelegationArchiveFormatPort {
  resultPath(archiveBasePath: string, agentPath: string): string
  formatParentTranscript(messages: ModelItem[]): string
}

/** Product dependencies that complete one core child-run runtime. */
export interface DelegationRuntimePorts {
  scheduler: SubagentScheduler
  archive: SubagentArchivePort
  archiveFormat: DelegationArchiveFormatPort
  /**
   * 子 agent 档位路由表（Pro/Flash 抽象档位 → 具体 vendor+模型）。
   * 省略时用 core 内暂存的默认表；装配层接管默认表后（M6b）由这里传入。
   */
  tierRouting?: SubagentTierRouting
}
