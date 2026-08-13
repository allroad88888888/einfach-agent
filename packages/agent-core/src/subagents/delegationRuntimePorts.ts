import type { ModelItem } from '@web-agent/ai'
import type { SubagentScheduler } from '../runtime/delegationContract'
import type { ModelSettings } from '../state/core.type'
import type { SubagentTierRouting } from './tierRouting'
import type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentChildSpec,
  DelegateAgentInput,
  DelegateAgentStrategy,
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
  /** 一次 run 的归档根目录；目录布局（`.webAgent-archive/…`）由装配层决定。 */
  cacheBasePath(sessionId: string, runId: string): string
  eventsPath(archiveBasePath: string): string
  resultPath(archiveBasePath: string, agentPath: string): string
  formatParentTranscript(messages: ModelItem[]): string
}

/**
 * 一次无工具蒸馏请求。core 侧的 chat 包装把它变成一次模型调用，
 * 蒸馏实现只管拼 prompt、不碰调用帧。
 */
export interface SkillDistillChatInput {
  purpose: 'core' | 'child_brief'
  agentPath: string
  system: string
  user: string
}

/** 一批子 agent 的蒸馏入参；`chat` 由调用方预先绑定好调用状态后传入。 */
export interface SubagentSkillDistillInput {
  conversationId: string
  runId: string
  cacheBasePath: string
  parentPath: string
  parentDispatchIndex?: number
  parentTranscript: string
  inheritedSkillFiles: string[]
  inheritedSkillIds: string[]
  children: Array<{
    node: SubagentNodeRecord
    spec: DelegateAgentChildSpec
  }>
  chat: (input: SkillDistillChatInput) => Promise<string>
  strategy?: DelegateAgentStrategy
}

export interface SubagentSkillDistillResult {
  coreSkill: SubagentSkillFile
  childSkills: SubagentSkillFile[]
}

/**
 * Product-owned skill distillation for one delegate batch: prompt 文案、skill 文件命名、
 * 内容哈希与降级 brief 都是归档产品的事，core 只负责在派发时点调用它并落盘结果。
 */
export interface SubagentSkillDistillPort {
  distill(input: SubagentSkillDistillInput): Promise<SubagentSkillDistillResult>
}

/** Product dependencies that complete one core child-run runtime. */
export interface DelegationRuntimePorts {
  scheduler: SubagentScheduler
  archive: SubagentArchivePort
  archiveFormat: DelegationArchiveFormatPort
  skillDistill: SubagentSkillDistillPort
  /**
   * 低价抽取请求的厂商档设置：在主设置基础上换成 flash 档模型，并按 vendor 决定还能带哪些
   * 采样字段。与 `tierRouting` 同理必填——"某家 vendor 的会话类型不接受 temperature/max_tokens"
   * 是真实行为差异，属厂商判断；core 没有中立的默认写法可言（这里写死任何一种拼法，都等于
   * 把某一家的采样约定当成通用规则），缺省注入即装配错误，让 TypeScript 在编译期拦下。
   * 装配层实现见 `packages/subagents/src/runtime.ts`。
   */
  lowCostExtractionSettings(primary: ModelSettings, model: string, maxTokens: number): ModelSettings
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
