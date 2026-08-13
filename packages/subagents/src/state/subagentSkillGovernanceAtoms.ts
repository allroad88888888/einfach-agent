import { atom } from '@einfach/core'
import {
  subagentStatePort,
  type ReadWorkspaceFileInput,
  type ReadWorkspaceFileResult,
  type SkillGovernanceAction,
  type SkillGovernanceOperation,
  type WorkspaceRuntimeResult,
} from '@web-agent/core/state/stateViewPort'

const SKILLS_INDEX_PATH = '.webAgent-archive/index/skills.jsonl'
const SKILL_ID = /^sk_[a-zA-Z0-9_-]{1,92}$/
const CONTENT_HASH = /^h64:[0-9a-z]{14}$/

type Reader = (input: ReadWorkspaceFileInput) => Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>
type Preparer = typeof subagentStatePort.prepareSkillGovernance

export interface CandidateSkillScorePart { label: string; points: number; maximum: number; explanation: string }
export interface CandidateSkill {
  skillId: string
  kind: string
  summary: string
  createdAt?: string
  globalPath: string
  score: number
  scoreParts: CandidateSkillScorePart[]
}

export interface CandidateSkillsState {
  workspaceRoot?: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  candidates: CandidateSkill[]
  error?: string
}

export interface SkillGovernanceDialogState {
  status: 'closed' | 'confirming' | 'submitting' | 'prepared' | 'error'
  action?: SkillGovernanceAction
  candidate?: CandidateSkill
  workspaceRoot?: string
  operation?: SkillGovernanceOperation
  error?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context} 缺少字符串字段`)
  return value
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${context} 不是字符串数组`)
  return value as string[]
}

export function scoreCandidateSkill(input: {
  summary: string
  contentHash: string
  inheritSkillIds: string[]
  sourceTranscriptChars?: number
}): { score: number; parts: CandidateSkillScorePart[] } {
  const transcriptChars = input.sourceTranscriptChars ?? 0
  const evidence = Math.min(30, Math.floor(transcriptChars / 250))
  const specificity = Math.min(25, Math.floor(input.summary.trim().length / 16))
  const lineage = Math.min(20, input.inheritSkillIds.length * 5)
  const identity = CONTENT_HASH.test(input.contentHash) ? 25 : 0
  const parts = [
    { label: '来源证据', points: evidence, maximum: 30, explanation: `${transcriptChars} 个 transcript 字符，每 250 字符 1 分` },
    { label: '摘要信息量', points: specificity, maximum: 25, explanation: `${input.summary.trim().length} 个摘要字符，每 16 字符 1 分` },
    { label: '继承链路', points: lineage, maximum: 20, explanation: `${input.inheritSkillIds.length} 个被继承 skill，每项 5 分` },
    { label: '内容身份', points: identity, maximum: 25, explanation: identity ? 'contentHash 格式完整' : 'contentHash 格式异常' },
  ]
  return { score: parts.reduce((total, part) => total + part.points, 0), parts }
}

export function parseCandidateSkillsIndex(content: string, truncated = false): CandidateSkill[] {
  if (truncated) throw new Error('skills 索引超过 200KB，拒绝基于不完整数据评分')
  const latest = new Map<string, Record<string, unknown>>()
  content.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error(`skills 索引第 ${index + 1} 行不是合法 JSON`) }
    const item = record(parsed)
    if (!item) throw new Error(`skills 索引第 ${index + 1} 行不是对象`)
    if (item.type !== 'skill') throw new Error(`skills 索引第 ${index + 1} 行 type 不合法`)
    const skillId = requiredString(item.skillId, `skills 索引第 ${index + 1} 行 skillId`)
    if (!SKILL_ID.test(skillId)) throw new Error(`skills 索引第 ${index + 1} 行 skillId 不合法`)
    if (!['candidate', 'promoted', 'archived', 'ephemeral'].includes(String(item.promotion))) {
      throw new Error(`skills 索引第 ${index + 1} 行 promotion 不合法`)
    }
    latest.set(skillId, item)
  })
  return [...latest.values()].filter((item) => item.promotion === 'candidate').map((item) => {
    const skillId = item.skillId as string
    const globalPath = requiredString(item.globalPath, `${skillId} globalPath`)
    if (globalPath !== `.webAgent-archive/skills/${skillId}.md`) throw new Error(`${skillId} globalPath 不合法`)
    const summary = requiredString(item.summary, `${skillId} summary`)
    const kind = requiredString(item.kind, `${skillId} kind`)
    const contentHash = requiredString(item.contentHash, `${skillId} contentHash`)
    if (!CONTENT_HASH.test(contentHash)) throw new Error(`${skillId} contentHash 不合法`)
    const inheritSkillIds = stringList(item.inheritSkillIds, `${skillId} inheritSkillIds`)
    if (inheritSkillIds.some((id) => !SKILL_ID.test(id))) throw new Error(`${skillId} inheritSkillIds 不合法`)
    if (item.createdAt !== undefined && (typeof item.createdAt !== 'string' || !item.createdAt.trim())) {
      throw new Error(`${skillId} createdAt 不合法`)
    }
    const sourceTranscriptChars = item.sourceTranscriptChars === undefined ? undefined : item.sourceTranscriptChars
    if (sourceTranscriptChars !== undefined && (!Number.isSafeInteger(sourceTranscriptChars) || (sourceTranscriptChars as number) < 0)) {
      throw new Error(`${skillId} sourceTranscriptChars 不合法`)
    }
    const scored = scoreCandidateSkill({ summary, contentHash, inheritSkillIds, sourceTranscriptChars: sourceTranscriptChars as number | undefined })
    return { skillId, kind, summary, createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined, globalPath, score: scored.score, scoreParts: scored.parts }
  }).sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId))
}

function validateFrontmatter(markdown: string, candidate: CandidateSkill): void {
  const closing = markdown.indexOf('\n---', 4)
  if (!markdown.startsWith('---\n') || closing < 0) throw new Error(`${candidate.skillId} frontmatter 不完整`)
  const header = markdown.slice(4, closing)
  const id = /^skill_id:\s*(.+)$/m.exec(header)
  const promotion = /^promotion:\s*(.+)$/m.exec(header)
  try {
    if (!id || JSON.parse(id[1]) !== candidate.skillId || !promotion || JSON.parse(promotion[1]) !== 'candidate') throw new Error()
  } catch { throw new Error(`${candidate.skillId} index 与 frontmatter 不一致`) }
}

export async function readCandidateSkills(workspaceRoot?: string, reader: Reader = subagentStatePort.readWorkspaceFile): Promise<CandidateSkillsState> {
  const index = await reader({ path: SKILLS_INDEX_PATH, maxBytes: 200_000, workspaceRoot })
  if (!index.ok) return { workspaceRoot, status: /not found|does not exist|no such file/i.test(index.error) ? 'empty' : 'error', candidates: [], error: index.error }
  try {
    const candidates = parseCandidateSkillsIndex(index.data.content, index.data.truncated)
    await Promise.all(candidates.map(async (candidate) => {
      const file = await reader({ path: candidate.globalPath, maxBytes: 200_000, workspaceRoot })
      if (!file.ok) throw new Error(`${candidate.skillId} global skill 读取失败：${file.error}`)
      if (file.data.truncated) throw new Error(`${candidate.skillId} global skill 超过 200KB`)
      validateFrontmatter(file.data.content, candidate)
    }))
    return { workspaceRoot, status: candidates.length ? 'ready' : 'empty', candidates, error: candidates.length ? undefined : '暂无 candidate skill' }
  } catch (error) {
    return { workspaceRoot, status: 'error', candidates: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export const candidateSkillsAtom = atom<CandidateSkillsState>({ status: 'idle', candidates: [] })
const candidateRequestTokenAtom = atom(0)
export const candidateSkillFilterAtom = atom('')
export const filteredCandidateSkillsAtom = atom((get) => {
  const query = get(candidateSkillFilterAtom).trim().toLowerCase()
  const candidates = get(candidateSkillsAtom).candidates
  return query ? candidates.filter((item) => `${item.skillId} ${item.kind} ${item.summary}`.toLowerCase().includes(query)) : candidates
})
export const selectedCandidateSkillIdAtom = atom<string | undefined>(undefined)
export const skillGovernanceDialogAtom = atom<SkillGovernanceDialogState>({ status: 'closed' })

export const loadCandidateSkillsAtom = atom(null, async (get, set, input: { workspaceRoot?: string; force?: boolean; reader?: Reader }) => {
  const current = get(candidateSkillsAtom)
  if (!input.force && current.status !== 'idle' && current.workspaceRoot === input.workspaceRoot) return
  const token = get(candidateRequestTokenAtom) + 1
  set(candidateRequestTokenAtom, token)
  set(candidateSkillsAtom, { workspaceRoot: input.workspaceRoot, status: 'loading', candidates: [] })
  const loaded = await readCandidateSkills(input.workspaceRoot, input.reader)
  if (get(candidateRequestTokenAtom) === token) set(candidateSkillsAtom, loaded)
})

export const openSkillGovernanceDialogAtom = atom(null, (_get, set, input: { action: SkillGovernanceAction; candidate: CandidateSkill; workspaceRoot?: string }) => {
  set(skillGovernanceDialogAtom, { status: 'confirming', ...input })
})
export const closeSkillGovernanceDialogAtom = atom(null, (_get, set) => set(skillGovernanceDialogAtom, { status: 'closed' }))
export const confirmSkillGovernanceAtom = atom(null, async (get, set, input?: { preparer?: Preparer }) => {
  const dialog = get(skillGovernanceDialogAtom)
  if (dialog.status !== 'confirming' || !dialog.action || !dialog.candidate) return
  set(skillGovernanceDialogAtom, { ...dialog, status: 'submitting' })
  try {
    const operation = await (input?.preparer ?? subagentStatePort.prepareSkillGovernance)({ action: dialog.action, skillId: dialog.candidate.skillId })
    set(skillGovernanceDialogAtom, { ...dialog, status: 'prepared', operation })
  } catch (error) {
    set(skillGovernanceDialogAtom, { ...dialog, status: 'error', error: error instanceof Error ? error.message : String(error) })
  }
})
