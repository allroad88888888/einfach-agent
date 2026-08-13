// core 内核测试用的最小技能蒸馏端口。
// ---------------------------------------------------------------------------
// 内核关心的只有三件事：蒸馏发了几次无工具模型请求（core skill 一次 + 每个子 agent 一次）、
// 请求正文里带着父对话、以及返回的 skill 正文原样落到子 agent 的 prompt 与归档里。
// prompt 文案、内容哈希、skill 命名与降级 brief 的具体形状是产品归档的事，这里不复制。

import { compactSubagentTranscript } from '../runtime/subagentTranscript'
import type { SubagentSkillDistillPort } from './delegationRuntimePorts'
import type { SubagentPath, SubagentSkillFile } from './types'

/** 与装配层同一个上限：父对话超长时「蒸馏请求本身是否超预算」是被测的内核行为。 */
const TEST_TRANSCRIPT_LIMIT = 16_000

function testSkillFile(input: {
  conversationId: string
  runId: string
  cacheBasePath: string
  parentPath: SubagentPath
  transcriptChars: number
  agentPath: SubagentPath
  kind: 'core' | 'task_brief'
  content: string
  inherits: string[]
  inheritSkillIds: string[]
}): SubagentSkillFile {
  const filename = `${input.agentPath}.${input.kind}.md`
  return {
    skillId: `sk_test_${input.agentPath}_${input.kind}`,
    conversationId: input.conversationId,
    runId: input.runId,
    path: `${input.cacheBasePath}/skills/${filename}`,
    globalPath: `.webAgent-archive/test/skills/${filename}`,
    filename,
    agentPath: input.agentPath,
    kind: input.kind,
    content: input.content,
    contentHash: `h64:test-${input.content.length}`,
    createdAt: new Date().toISOString(),
    ttl: 'permanent',
    promotion: 'candidate',
    inherits: input.inherits,
    inheritSkillIds: input.inheritSkillIds,
    source: {
      parentAgentPath: input.parentPath,
      parentSkillIds: input.inheritSkillIds,
      transcriptChars: input.transcriptChars,
    },
  }
}

export const testSkillDistill: SubagentSkillDistillPort = {
  async distill(input) {
    const transcript = compactSubagentTranscript(input.parentTranscript, TEST_TRANSCRIPT_LIMIT)
    const corePromise = input.chat({
      purpose: 'core',
      agentPath: input.parentPath,
      system: 'test core distill',
      user: [`父 agent path: ${input.parentPath}`, '', '父 agent 当前对话:', transcript].join('\n'),
    })
    const childPromises = input.children.map(async ({ node, spec }) => {
      const request = () => input.chat({
        purpose: 'child_brief',
        agentPath: node.path,
        system: 'test child brief distill',
        user: [
          `子 agent path: ${node.path}`,
          `任务目标: ${spec.objective}`,
          '',
          '父 agent 当前对话:',
          transcript,
        ].join('\n'),
      })
      // best-effort 批次里单个 brief 失败要降级成占位文本，整批不塌——这条分支内核会走到。
      if (input.strategy !== 'parallel_best_effort') return { node, content: await request() }
      try {
        return { node, content: await request() }
      } catch (error) {
        const reason = error instanceof Error ? error.message || error.name : String(error)
        return { node, content: `# 任务 Brief（占位）\n\n> fallback_reason: ${reason}` }
      }
    })

    const [coreContent, childDrafts] = await Promise.all([corePromise, Promise.all(childPromises)])
    const shared = {
      conversationId: input.conversationId,
      runId: input.runId,
      cacheBasePath: input.cacheBasePath,
      parentPath: input.parentPath,
      transcriptChars: transcript.length,
    }
    const coreSkill = testSkillFile({
      ...shared,
      agentPath: input.parentPath,
      kind: 'core',
      content: coreContent,
      inherits: [...input.inheritedSkillFiles],
      inheritSkillIds: [...input.inheritedSkillIds],
    })
    return {
      coreSkill,
      childSkills: childDrafts.map(({ node, content }) => testSkillFile({
        ...shared,
        agentPath: node.path,
        kind: 'task_brief',
        content,
        inherits: [...input.inheritedSkillFiles, coreSkill.path],
        inheritSkillIds: [...input.inheritedSkillIds, coreSkill.skillId],
      })),
    }
  },
}
