import { describe, expect, it } from 'vitest'
import {
  renderJsonLine,
  renderSkillMarkdown,
  subagentArchiveConversationBasePath,
  subagentCacheBasePath,
  subagentContentHash,
  subagentEventsPath,
  subagentGlobalSkillPath,
  subagentIndexPath,
  subagentRunPath,
  subagentSkillFilename,
  subagentSkillId,
} from './skillCache'
import type { SubagentSkillFile } from '@einfach-agent/core/subagents'

describe('subagent archive helpers', () => {
  it('names long-lived archive paths by conversation and run', () => {
    const base = subagentCacheBasePath('session id', 'run/id')

    expect(subagentArchiveConversationBasePath('session id')).toBe('.webAgent-archive/conversations/session_id')
    expect(base).toBe('.webAgent-archive/conversations/session_id/runs/run_id')
    expect(subagentRunPath(base)).toBe('.webAgent-archive/conversations/session_id/runs/run_id/run.json')
    expect(subagentEventsPath(base)).toBe('.webAgent-archive/conversations/session_id/runs/run_id/events.jsonl')
    expect(subagentIndexPath('skills')).toBe('.webAgent-archive/index/skills.jsonl')
  })

  it('keeps readable filenames but gives every skill a stable global id', () => {
    const contentHash = subagentContentHash('core notes')
    const skillId = subagentSkillId({
      conversationId: 's',
      runId: 'r',
      agentPath: 'root-01',
      ordinal: 1,
      kind: 'task_brief',
      contentHash,
    })

    expect(subagentSkillFilename('root-01', 1, 'task-brief')).toBe('root-01.01-task-brief.md')
    expect(skillId).toMatch(/^sk_[a-z0-9]+$/)
    expect(subagentGlobalSkillPath(skillId)).toBe(`.webAgent-archive/skills/${skillId}.md`)
    expect(
      subagentSkillId({
        conversationId: 's',
        runId: 'r',
        agentPath: 'root-01',
        ordinal: 1,
        kind: 'task_brief',
        contentHash,
      }),
    ).toBe(skillId)
  })

  it('renders replay metadata into skill frontmatter', () => {
    const skill: SubagentSkillFile = {
      skillId: 'sk_abc',
      conversationId: 'session',
      runId: 'run',
      path: '.webAgent-archive/conversations/session/runs/run/skills/root.01-core.md',
      globalPath: '.webAgent-archive/skills/sk_abc.md',
      filename: 'root.01-core.md',
      agentPath: 'root',
      kind: 'core',
      content: '# Core\n\nKeep the tree small.',
      contentHash: 'h64:abc',
      createdAt: '2026-07-09T00:00:00.000Z',
      ttl: 'permanent',
      promotion: 'candidate',
      inherits: [],
      inheritSkillIds: [],
      source: {
        parentAgentPath: 'root',
        parentSkillIds: [],
        transcriptChars: 42,
      },
    }

    expect(renderSkillMarkdown(skill)).toContain('skill_id: "sk_abc"')
    expect(renderSkillMarkdown(skill)).toContain('conversation_id: "session"')
    expect(renderSkillMarkdown(skill)).toContain('ttl: "permanent"')
    expect(renderSkillMarkdown(skill)).toContain('promotion: "candidate"')
    expect(renderSkillMarkdown(skill)).toContain('transcript_chars: 42')
    expect(JSON.parse(renderJsonLine({ skillId: skill.skillId }))).toEqual({ skillId: 'sk_abc' })
  })
})
