import { basename, posix } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveRolloutHistoryPath } from './rolloutPath'

describe('resolveRolloutHistoryPath', () => {
  it('maps root targets deterministically below the rollout directory', () => {
    const target = { kind: 'root' as const, conversationId: 'conversation/../CON' }
    const first = resolveRolloutHistoryPath('/data/app', target)
    expect(first).toEqual(resolveRolloutHistoryPath('/data/app', target))
    expect(first.filePath).toMatch(/^\/data\/app\/rollouts\/conversations\/[a-f0-9]{64}\/root\.jsonl$/)
    expect(posix.relative('/data/app', first.filePath)).not.toMatch(/^\.\./)
  })

  it('never exposes child ids as path segments', () => {
    const resolved = resolveRolloutHistoryPath('C:\\data\\app', {
      kind: 'child', conversationId: '..\\con', runId: 'AUX', agentPath: 'x/'.repeat(500),
    })
    expect(basename(resolved.filePath)).toMatch(/^[a-f0-9]{64}\.jsonl$/)
    expect(resolved.filePath).not.toContain('AUX')
    expect(resolved.filePath.length).toBeLessThan(300)
  })

  it('separates every logical component', () => {
    const base = { kind: 'child' as const, conversationId: 'c', runId: 'r', agentPath: 'a' }
    const paths = [base, { ...base, runId: 'r2' }, { ...base, agentPath: 'a2' }]
      .map((target) => resolveRolloutHistoryPath('/data', target).filePath)
    expect(new Set(paths).size).toBe(3)
  })
})
