import { describe, expect, it, vi } from 'vitest'
import { SubagentArchiveIO } from './archiveIO'
import type { DelegateAgentCallContext, SubagentNodeRecord, SubagentSkillFile } from '@web-agent/core/subagents/types'

const archiveBasePath = '.webAgent-archive/conversations/session/runs/run'

function context(writes: Map<string, string>): DelegateAgentCallContext {
  return {
    parentPath: 'root',
    progress() {},
    async writeTextFile(input) {
      const previous = input.mode === 'append' ? writes.get(input.path) ?? '' : ''
      writes.set(input.path, `${previous}${input.content}`)
      return { ok: true }
    },
  }
}

function skill(): SubagentSkillFile {
  return {
    skillId: 'skill-root',
    conversationId: 'session',
    runId: 'run',
    path: `${archiveBasePath}/skills/root.md`,
    globalPath: '.webAgent-archive/skills/skill-root.md',
    filename: 'root.md',
    agentPath: 'root',
    kind: 'core',
    content: '# Root skill',
    contentHash: 'hash-root',
    createdAt: '2026-08-03T00:00:00.000Z',
    ttl: 'session',
    promotion: 'ephemeral',
    inherits: [],
    inheritSkillIds: [],
    source: { parentSkillIds: [], transcriptChars: 0 },
  }
}

function node(): SubagentNodeRecord {
  return {
    id: 'root-node',
    treeId: 'run',
    sessionId: 'session',
    path: 'root',
    status: 'running',
    objective: 'archive test',
    depth: 0,
    dispatchCounter: 0,
    childCounter: 0,
    createdAt: 1,
    updatedAt: 2,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function events(writes: Map<string, string>): Array<{ type: string; eventId: string }> {
  return (writes.get(`${archiveBasePath}/events.jsonl`) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; eventId: string })
}

describe('SubagentArchiveIO', () => {
  it('persists run, skill, tree, and event archive documents', async () => {
    const writes = new Map<string, string>()
    const archive = new SubagentArchiveIO({
      writerContext: { queueKey: {} },
      sessionId: 'session',
      runId: 'run',
      model: 'deepseek-v4-pro',
      vendor: 'deepseek',
    })

    await archive.ensureArchiveInitialized(context(writes), archiveBasePath)
    await archive.persistSkill(context(writes), archiveBasePath, skill())
    await archive.persistTreeSnapshot(context(writes), archiveBasePath, [node()])
    await archive.close()

    expect(JSON.parse(writes.get('.webAgent-archive/conversations/session/conversation.json') ?? '')).toMatchObject({
      archiveVersion: 1,
      conversationId: 'session',
    })
    expect(JSON.parse(writes.get(`${archiveBasePath}/run.json`) ?? '')).toMatchObject({
      runId: 'run',
      status: 'running',
      eventLog: `${archiveBasePath}/events.jsonl`,
    })
    expect(writes.get(`${archiveBasePath}/skills/root.md`)).toContain('# Root skill')
    expect(writes.get(`${archiveBasePath}/tree.json`)).toContain('root-node')
    expect(writes.get('.webAgent-archive/index/skills.jsonl')).toContain('skill-root')
    expect(writes.get('.webAgent-archive/index/agents.jsonl')).toContain('root-node')
    expect(events(writes).map(({ type, eventId }) => ({ type, eventId }))).toEqual([
      { type: 'archive_initialized', eventId: 'run:evt-0001' },
      { type: 'skill_written', eventId: 'run:evt-0002' },
      { type: 'tree_snapshot_written', eventId: 'run:evt-0003' },
    ])
  })

  it('retries initialization and keeps observability writes best effort', async () => {
    const writes = new Map<string, string>()
    const onTraceItem = vi.fn()
    let attempts = 0
    const callContext = context(writes)
    callContext.writeTextFile = async (input) => {
      if (input.path.endsWith('/conversation.json') && attempts++ === 0) {
        return { ok: false, error: 'temporary failure' }
      }
      const previous = input.mode === 'append' ? writes.get(input.path) ?? '' : ''
      writes.set(input.path, `${previous}${input.content}`)
      return { ok: true }
    }
    const archive = new SubagentArchiveIO({
      writerContext: { queueKey: {} },
      sessionId: 'session',
      runId: 'run',
      model: 'deepseek-v4-pro',
      vendor: 'deepseek',
      onTraceItem,
    })

    await expect(archive.ensureArchiveInitialized(callContext, archiveBasePath))
      .rejects.toThrow('temporary failure')
    await archive.ensureArchiveInitialized(callContext, archiveBasePath)

    callContext.writeTextFile = async () => {
      throw new Error('host disconnected')
    }
    await expect(archive.bestEffortRecordEvent(
      callContext,
      archiveBasePath,
      'delegate_finished',
      'root',
    )).resolves.toBeUndefined()
    await expect(archive.bestEffortRecordTraceItem(
      callContext,
      archiveBasePath,
      'root',
      1,
      { role: 'assistant', content: 'done' },
    )).resolves.toBeUndefined()
    expect(onTraceItem).toHaveBeenCalledWith(expect.objectContaining({ agentPath: 'root', turn: 1 }))
    await archive.close()
  })
})
