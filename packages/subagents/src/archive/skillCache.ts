import type { SubagentNodeRecord, SubagentSkillFile } from '@einfach-agent/core/subagents'

const ARCHIVE_ROOT = '.webAgent-archive'
const MAX_SEGMENT_LENGTH = 96

function safeSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SEGMENT_LENGTH)
  return safe || 'unknown'
}

function stableHash(value: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const high = (h2 >>> 0).toString(36).padStart(7, '0')
  const low = (h1 >>> 0).toString(36).padStart(7, '0')
  return `${high}${low}`
}

function safeKind(value: string): string {
  return safeSegment(value).toLowerCase()
}

function yamlString(value: string | undefined): string {
  return JSON.stringify(value ?? '')
}

function yamlStringList(values: string[], indent = ''): string {
  if (values.length === 0) return '[]'
  return `\n${values.map((value) => `${indent}  - ${JSON.stringify(value)}`).join('\n')}`
}

export function subagentCacheBasePath(sessionId: string, treeId: string): string {
  return subagentArchiveRunBasePath(sessionId, treeId)
}

export function subagentArchiveConversationBasePath(sessionId: string): string {
  return `${ARCHIVE_ROOT}/conversations/${safeSegment(sessionId)}`
}

export function subagentArchiveRunBasePath(sessionId: string, runId: string): string {
  return `${subagentArchiveConversationBasePath(sessionId)}/runs/${safeSegment(runId)}`
}

export function subagentGlobalSkillPath(skillId: string): string {
  return `${ARCHIVE_ROOT}/skills/${safeSegment(skillId)}.md`
}

export function subagentIndexPath(name: 'runs' | 'skills' | 'agents'): string {
  return `${ARCHIVE_ROOT}/index/${name}.jsonl`
}

export function subagentSkillFilename(agentPath: string, ordinal: number, kind: string): string {
  const safeOrdinal = Math.max(1, Math.floor(ordinal))
  return `${safeSegment(agentPath)}.${String(safeOrdinal).padStart(2, '0')}-${safeKind(kind)}.md`
}

export function subagentSkillPath(basePath: string, filename: string): string {
  return `${basePath}/skills/${filename}`
}

export function subagentNodePath(basePath: string, agentPath: string): string {
  return `${basePath}/nodes/${safeSegment(agentPath)}.json`
}

export function subagentResultPath(basePath: string, agentPath: string): string {
  return `${basePath}/results/${safeSegment(agentPath)}.result.md`
}

export function subagentTracePath(basePath: string, agentPath: string): string {
  return `${basePath}/traces/${safeSegment(agentPath)}.trace.jsonl`
}

export function subagentTreePath(basePath: string): string {
  return `${basePath}/tree.json`
}

export function subagentConversationPath(sessionId: string): string {
  return `${subagentArchiveConversationBasePath(sessionId)}/conversation.json`
}

export function subagentRunPath(basePath: string): string {
  return `${basePath}/run.json`
}

export function subagentEventsPath(basePath: string): string {
  return `${basePath}/events.jsonl`
}

export function subagentContentHash(content: string): string {
  return `h64:${stableHash(content)}`
}

export function subagentSkillId(input: {
  conversationId: string
  runId: string
  agentPath: string
  ordinal: number
  kind: string
  contentHash: string
}): string {
  const seed = [
    input.conversationId,
    input.runId,
    input.agentPath,
    String(input.ordinal),
    input.kind,
    input.contentHash,
  ].join('\n')
  return `sk_${stableHash(seed)}`
}

export function renderJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function renderJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

export function renderSkillMarkdown(skill: SubagentSkillFile): string {
  return [
    '---',
    `skill_id: ${JSON.stringify(skill.skillId)}`,
    `conversation_id: ${JSON.stringify(skill.conversationId)}`,
    `run_id: ${JSON.stringify(skill.runId)}`,
    `agent_path: ${JSON.stringify(skill.agentPath)}`,
    `kind: ${JSON.stringify(skill.kind)}`,
    `filename: ${JSON.stringify(skill.filename)}`,
    `content_hash: ${JSON.stringify(skill.contentHash)}`,
    `created_at: ${JSON.stringify(skill.createdAt)}`,
    `inherits:${yamlStringList(skill.inherits)}`,
    `inherit_skill_ids:${yamlStringList(skill.inheritSkillIds)}`,
    'source:',
    `  parent_agent_path: ${yamlString(skill.source.parentAgentPath)}`,
    `  parent_skill_ids:${yamlStringList(skill.source.parentSkillIds, '  ')}`,
    `  transcript_chars: ${skill.source.transcriptChars}`,
    `ttl: ${JSON.stringify(skill.ttl)}`,
    `promotion: ${JSON.stringify(skill.promotion)}`,
    '---',
    '',
    skill.content.trim(),
    '',
  ].join('\n')
}

export function renderNodeRecord(node: SubagentNodeRecord): string {
  return renderJsonDocument(node)
}

export function renderTreeSnapshot(nodes: SubagentNodeRecord[]): string {
  return renderJsonDocument({ nodes })
}
