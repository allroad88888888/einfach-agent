import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import type { ReadWorkspaceFileInput, ReadWorkspaceFileResult, WorkspaceRuntimeResult } from '../runtime/workspaceRead'
import { prepareSubagentSkillGovernance } from '../runtime/skillGovernance'
import {
  candidateSkillsAtom,
  confirmSkillGovernanceAtom,
  loadCandidateSkillsAtom,
  openSkillGovernanceDialogAtom,
  parseCandidateSkillsIndex,
  readCandidateSkills,
  scoreCandidateSkill,
  skillGovernanceDialogAtom,
  type CandidateSkill,
} from './subagentSkillGovernanceAtoms'

const HASH = 'h64:1234567890abcd'

function indexRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'skill',
    skillId: 'sk_candidate',
    kind: 'core',
    globalPath: '.webAgent-archive/skills/sk_candidate.md',
    contentHash: HASH,
    promotion: 'candidate',
    inheritSkillIds: ['sk_parent'],
    sourceTranscriptChars: 2_500,
    createdAt: '2026-07-21T00:00:00.000Z',
    summary: 'x'.repeat(160),
    ...overrides,
  }
}

function markdown(skillId = 'sk_candidate', promotion = 'candidate'): string {
  return `---\nskill_id: ${JSON.stringify(skillId)}\npromotion: ${JSON.stringify(promotion)}\n---\n\nbody\n`
}

function candidate(): CandidateSkill {
  const scored = scoreCandidateSkill({
    summary: 'candidate summary', contentHash: HASH, inheritSkillIds: [], sourceTranscriptChars: 500,
  })
  return {
    skillId: 'sk_candidate', kind: 'core', summary: 'candidate summary',
    globalPath: '.webAgent-archive/skills/sk_candidate.md', score: scored.score, scoreParts: scored.parts,
  }
}

describe('subagent skill governance atoms', () => {
  it('使用确定且可解释的 100 分制，并匹配真实 h64 内容哈希', () => {
    const result = scoreCandidateSkill({
      summary: 'x'.repeat(160), contentHash: HASH, inheritSkillIds: ['sk_parent'], sourceTranscriptChars: 2_500,
    })

    expect(result.score).toBe(50)
    expect(result.parts).toEqual([
      expect.objectContaining({ label: '来源证据', points: 10, maximum: 30 }),
      expect.objectContaining({ label: '摘要信息量', points: 10, maximum: 25 }),
      expect.objectContaining({ label: '继承链路', points: 5, maximum: 20 }),
      expect.objectContaining({ label: '内容身份', points: 25, maximum: 25 }),
    ])
  })

  it('按最后一条状态去重，只返回 candidate，并稳定按分数和 skillId 排序', () => {
    const lines = [
      indexRecord({ skillId: 'sk_old', globalPath: '.webAgent-archive/skills/sk_old.md' }),
      indexRecord({ skillId: 'sk_old', globalPath: '.webAgent-archive/skills/sk_old.md', promotion: 'promoted' }),
      indexRecord({ skillId: 'sk_b', globalPath: '.webAgent-archive/skills/sk_b.md', inheritSkillIds: [] }),
      indexRecord({ skillId: 'sk_a', globalPath: '.webAgent-archive/skills/sk_a.md', inheritSkillIds: [] }),
    ].map((item) => JSON.stringify(item)).join('\n')

    expect(parseCandidateSkillsIndex(lines).map((item) => item.skillId)).toEqual(['sk_a', 'sk_b'])
  })

  it.each([
    ['截断索引', `${JSON.stringify(indexRecord())}\n`, true, '不完整数据'],
    ['坏 JSON', '{bad', false, '不是合法 JSON'],
    ['错误 type', JSON.stringify(indexRecord({ type: 'run' })), false, 'type 不合法'],
    ['错误 hash', JSON.stringify(indexRecord({ contentHash: 'h64:abc' })), false, 'contentHash 不合法'],
    ['越界路径', JSON.stringify(indexRecord({ globalPath: '../skill.md' })), false, 'globalPath 不合法'],
    ['错误继承 id', JSON.stringify(indexRecord({ inheritSkillIds: ['../bad'] })), false, 'inheritSkillIds 不合法'],
  ])('%s 时 fail-closed', (_name, content, truncated, message) => {
    expect(() => parseCandidateSkillsIndex(content, truncated)).toThrow(message)
  })

  it('逐个校验 global skill frontmatter，不一致时不返回部分候选项', async () => {
    const reader = async (input: ReadWorkspaceFileInput): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => {
      const content = input.path.endsWith('skills.jsonl')
        ? JSON.stringify(indexRecord())
        : markdown('sk_other')
      return { ok: true, data: { path: input.path, content, bytes: content.length, truncated: false } }
    }

    await expect(readCandidateSkills('/workspace', reader)).resolves.toMatchObject({
      status: 'error', candidates: [], error: expect.stringContaining('index 与 frontmatter 不一致'),
    })
  })

  it('切换 workspace 后旧加载结果不会覆盖新状态', async () => {
    const store = createStore()
    let resolveOld!: (result: WorkspaceRuntimeResult<ReadWorkspaceFileResult>) => void
    const oldLoad = store.setter(loadCandidateSkillsAtom, {
      workspaceRoot: '/old',
      reader: () => new Promise((resolve) => { resolveOld = resolve }),
    })
    await store.setter(loadCandidateSkillsAtom, {
      workspaceRoot: '/new',
      reader: async () => ({ ok: false, error: 'file does not exist' }),
    })
    resolveOld({ ok: false, error: 'permission denied' })
    await oldLoad

    expect(store.getter(candidateSkillsAtom)).toMatchObject({ workspaceRoot: '/new', status: 'empty' })
  })

  it('显式确认只准备审计 CLI，并明确保持未执行状态', async () => {
    const store = createStore()
    store.setter(openSkillGovernanceDialogAtom, { action: 'promote', candidate: candidate(), workspaceRoot: '/workspace' })
    await store.setter(confirmSkillGovernanceAtom, {
      preparer: async ({ action, skillId }) => ({
        ok: true, action, skillId, command: `safe-command --${action} ${skillId}`,
      }),
    })

    expect(store.getter(skillGovernanceDialogAtom)).toMatchObject({
      status: 'prepared', action: 'promote',
      operation: { command: 'safe-command --promote sk_candidate' },
    })
  })

  it('准备 CLI 时拒绝非法 action 和 skillId，避免命令注入', async () => {
    await expect(prepareSubagentSkillGovernance({ action: 'delete' as 'promote', skillId: 'sk_candidate' }))
      .rejects.toThrow('invalid governance action')
    await expect(prepareSubagentSkillGovernance({ action: 'promote', skillId: 'sk_ok; rm' }))
      .rejects.toThrow('invalid managed skill id')
  })
})
