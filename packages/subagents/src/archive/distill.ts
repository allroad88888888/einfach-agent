import {
  compactSubagentTranscript,
  formatSubagentTranscript,
  type DelegateAgentChildSpec,
  type DelegateAgentStrategy,
  type SubagentNodeRecord,
  type SubagentSkillFile,
} from '@web-agent/core/subagents'
import {
  subagentContentHash,
  subagentGlobalSkillPath,
  subagentSkillId,
  subagentSkillFilename,
  subagentSkillPath,
} from './skillCache'

export interface SkillDistillChatInput {
  purpose: 'core' | 'child_brief'
  agentPath: string
  system: string
  user: string
}

export type SkillDistillChat = (input: SkillDistillChatInput) => Promise<string>
export type DistillStrategy = DelegateAgentStrategy

type ChildBriefResult =
  | { kind: 'success'; node: SubagentNodeRecord; spec: DelegateAgentChildSpec; content: string }
  | { kind: 'fallback'; node: SubagentNodeRecord; spec: DelegateAgentChildSpec; content: string; error: string }

export interface DistillDelegateSkillsInput {
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
  chat: SkillDistillChat
  strategy?: DistillStrategy
}

export interface DistilledDelegateSkills {
  coreSkill: SubagentSkillFile
  childSkills: SubagentSkillFile[]
}

export { formatSubagentTranscript }

function coreSkillSystemPrompt(): string {
  return [
    '你是本地 Agent Runtime 的上下文蒸馏器。',
    '把父 agent 的当前对话压缩成可继承的临时 skill。',
    '只保留目标、约束、已经做出的架构决策、重要文件路径、风险和下一步线索。',
    '不要输出寒暄，不要输出未证实的细节，不要泄露长篇推理过程。',
    '用 Markdown 输出，标题短，内容可被子 agent 直接执行。',
  ].join('\n')
}

function childBriefSystemPrompt(): string {
  return [
    '你是本地 Agent Runtime 的子任务 brief 生成器。',
    '根据父 agent 的对话和指定子任务，为一个子 agent 生成独立可执行的临时 skill。',
    'brief 必须包含任务目标、上下文、边界、允许输出、验收标准和禁止事项。',
    '不要让子 agent 直接改无关文件；不确定时要求返回发现和建议。',
    '用 Markdown 输出，避免长篇原始对话复制。',
  ].join('\n')
}

function coreSkillUserPrompt(parentPath: string, transcript: string): string {
  return [
    `父 agent path: ${parentPath}`,
    '',
    '父 agent 当前对话:',
    transcript,
    '',
    '请生成 core skill。',
  ].join('\n')
}

function childBriefUserPrompt(args: {
  parentPath: string
  childPath: string
  child: DelegateAgentChildSpec
  transcript: string
}): string {
  return [
    `父 agent path: ${args.parentPath}`,
    `子 agent path: ${args.childPath}`,
    `mode: ${args.child.mode ?? 'general'}`,
    '',
    `任务目标: ${args.child.objective}`,
    args.child.expectedOutput ? `期望输出: ${args.child.expectedOutput}` : '',
    '',
    '父 agent 当前对话:',
    args.transcript,
    '',
    '请生成 child task brief skill。',
  ]
    .filter(Boolean)
    .join('\n')
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'unknown error'
}

function childBriefFallbackContent(args: {
  parentPath: string
  node: SubagentNodeRecord
  spec: DelegateAgentChildSpec
  error: string
}): string {
  return [
    '# 任务 Brief（占位）',
    '',
    `- 父路径: ${args.parentPath}`,
    `- 子路径: ${args.node.path}`,
    `- 目标: ${args.spec.objective}`,
    `- 模式: ${args.spec.mode ?? 'general'}`,
    args.spec.expectedOutput ? `- 期望输出: ${args.spec.expectedOutput}` : '- 期望输出: 结论、风险、建议下一步',
    '',
    '模型未能稳定生成详细 brief（子 agent 已降级）。请基于父上下文先做问题切分，再产出可核验结论和建议。',
    '',
    `> fallback_reason: ${args.error}`,
  ].join('\n')
}

export async function distillDelegateSkills(
  input: DistillDelegateSkillsInput,
): Promise<DistilledDelegateSkills> {
  const strategy = input.strategy ?? 'parallel_wait_all'
  const transcript = compactSubagentTranscript(input.parentTranscript, 16_000)
  const coreDispatchIndex = Math.max(1, Math.floor(input.parentDispatchIndex ?? 1))
  const coreFilename = subagentSkillFilename(input.parentPath, coreDispatchIndex, 'core')
  const corePath = subagentSkillPath(input.cacheBasePath, coreFilename)

  const corePromise = input.chat({
    purpose: 'core',
    agentPath: input.parentPath,
    system: coreSkillSystemPrompt(),
    user: coreSkillUserPrompt(input.parentPath, transcript),
  })

  const childPromises = input.children.map(async ({ node, spec }) => {
    const request = () =>
      input.chat({
        purpose: 'child_brief',
        agentPath: node.path,
        system: childBriefSystemPrompt(),
        user: childBriefUserPrompt({
          parentPath: input.parentPath,
          childPath: node.path,
          child: spec,
          transcript,
        }),
      })

    if (strategy === 'parallel_best_effort') {
      try {
        const content = await request()
        return { kind: 'success', node, spec, content } satisfies ChildBriefResult
      } catch (error) {
        const reason = toErrorMessage(error)
        return {
          kind: 'fallback',
          node,
          spec,
          error: reason,
          content: childBriefFallbackContent({
            parentPath: input.parentPath,
            node,
            spec,
            error: reason,
          }),
        } satisfies ChildBriefResult
      }
    }

    const content = await request()
    return { kind: 'success', node, spec, content } satisfies ChildBriefResult
  })

  const [coreContent, childDrafts] = await Promise.all([corePromise, Promise.all(childPromises)])
  const coreContentHash = subagentContentHash(coreContent)
  const coreSkillId = subagentSkillId({
    conversationId: input.conversationId,
    runId: input.runId,
    agentPath: input.parentPath,
    ordinal: coreDispatchIndex,
    kind: 'core',
    contentHash: coreContentHash,
  })
  const childSkills = childDrafts.map(({ node, content }) => {
    const filename = subagentSkillFilename(node.path, 1, 'task-brief')
    const contentHash = subagentContentHash(content)
    const skillId = subagentSkillId({
      conversationId: input.conversationId,
      runId: input.runId,
      agentPath: node.path,
      ordinal: 1,
      kind: 'task_brief',
      contentHash,
    })
    return {
      skillId,
      conversationId: input.conversationId,
      runId: input.runId,
      path: subagentSkillPath(input.cacheBasePath, filename),
      globalPath: subagentGlobalSkillPath(skillId),
      filename,
      agentPath: node.path,
      kind: 'task_brief',
      content,
      contentHash,
      createdAt: new Date().toISOString(),
      ttl: 'permanent',
      promotion: 'candidate',
      inherits: [...input.inheritedSkillFiles, corePath],
      inheritSkillIds: [...input.inheritedSkillIds, coreSkillId],
      source: {
        parentAgentPath: input.parentPath,
        parentSkillIds: [...input.inheritedSkillIds, coreSkillId],
        transcriptChars: transcript.length,
      },
    } satisfies SubagentSkillFile
  })

  return {
    coreSkill: {
      skillId: coreSkillId,
      conversationId: input.conversationId,
      runId: input.runId,
      path: corePath,
      globalPath: subagentGlobalSkillPath(coreSkillId),
      filename: coreFilename,
      agentPath: input.parentPath,
      kind: 'core',
      content: coreContent,
      contentHash: coreContentHash,
      createdAt: new Date().toISOString(),
      ttl: 'permanent',
      promotion: 'candidate',
      inherits: input.inheritedSkillFiles,
      inheritSkillIds: input.inheritedSkillIds,
      source: {
        parentAgentPath: input.parentPath,
        parentSkillIds: input.inheritedSkillIds,
        transcriptChars: transcript.length,
      },
    },
    childSkills,
  }
}
