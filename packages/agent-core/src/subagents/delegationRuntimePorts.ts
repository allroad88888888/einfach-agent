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
   * 必填，与其余三个端口同风格：这张表的默认取值本身就是厂商决策（用哪家、哪个模型号），
   * 不属于 core 该固化的东西，因此不像其余可选字段那样在 core 内兜一个默认值——
   * core 没有"中立"的默认档位表可言，缺省注入就是装配错误，让 TypeScript 在编译期拦下，
   * 而不是在运行时悄悄退回一张只对某家 vendor 有意义的表。装配层默认表见
   * `packages/subagents/src/defaultTierRouting.ts`。
   */
  tierRouting: SubagentTierRouting
}
