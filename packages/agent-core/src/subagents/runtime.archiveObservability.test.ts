import { describe, expect, it } from 'vitest'
import type { DelegateAgentCallContext } from './types'
import {
  childPath,
  context,
  eventsTyped,
  requestBody,
  response,
  runtime,
} from './runtime.testHarness'

describe('createDelegateAgentRuntime · 归档与缓存观测', () => {
  it('archives provider cache usage for child, evaluator, and distill calls', async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 75,
      prompt_cache_miss_tokens: 25,
    }
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      return childPath(body)
        ? response({ role: 'assistant', content: 'done' }, usage)
        : response({ role: 'assistant', content: '# distilled skill' }, usage)
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [
        { objective: 'inspect as worker', mode: 'worker' },
        { objective: 'inspect as evaluator', mode: 'evaluator' },
      ],
    }, context(writes))

    expect(result.children.every((child) => child.status === 'done')).toBe(true)
    const usageEvents = eventsTyped(writes, 'child_model_usage')
    // 一次 core skill + 每个 child 各一次 brief，共 3 次 distill；随后 worker/evaluator 各 1 次。
    expect(usageEvents).toHaveLength(5)
    expect(usageEvents.map((event) => event.data?.phase).sort())
      .toEqual([
        'distill:child_brief',
        'distill:child_brief',
        'distill:core',
        'evaluator',
        'subagent',
      ])
    for (const event of usageEvents) {
      expect(event.data).toMatchObject({
        promptTk: 100,
        completionTk: 20,
        totalTk: 120,
        cacheMetricsStatus: 'available',
        cacheHitTk: 75,
        cacheMissTk: 25,
        cacheMissSource: 'provider',
        cacheHitRate: 0.75,
        cacheProtocolVersion: 'agent-runtime-prefix-v2',
        cacheLane: event.data?.phase,
        compactionBoundary: 'full-history',
        contextDistilled: false,
        withinBudget: true,
      })
      expect(String(event.data?.cacheProfile)).toContain(String(event.data?.phase))
      expect(event.data?.cacheEpoch).toBe(1)
      expect(event.data?.cacheEpochReason).toBe('initial')
      expect(String(event.data?.laneScopeFingerprint)).toMatch(/^scope-v2-fnv1a32-/)
      expect(String(event.data?.systemFingerprint)).toMatch(/^system-v2-fnv1a32-/)
      expect(String(event.data?.requestProjectionFingerprint)).toMatch(/^request-v2-fnv1a32-/)
      expect(String(event.data?.toolSetFingerprint)).toMatch(/^tools-v1-fnv1a32-/)
    }

    const coreDistill = usageEvents.find((event) => event.data?.phase === 'distill:core')
    const childBriefs = usageEvents.filter((event) => event.data?.phase === 'distill:child_brief')
    expect(coreDistill?.agentPath).toBe('root')
    expect(childBriefs.map((event) => event.agentPath).sort()).toEqual(['root-01', 'root-02'])

    await delegateRuntime.dispose?.()
  })

  it('throws when an injected archive writer reports ok:false', async () => {
    const delegateRuntime = runtime(async () => response({ content: '# skill' }))
    await expect(
      delegateRuntime.delegateAgents(
        { children: [{ objective: 'child' }] },
        {
          parentPath: 'root',
          progress() {},
          async writeTextFile() {
            return { ok: false, error: 'disk full' }
          },
        },
      ),
    ).rejects.toThrow('disk full')
    delegateRuntime.dispose?.()
  })

  it('batches high-frequency skill and agent index appends but not audit events', async () => {
    const writes: Array<{ path: string; content: string; mode?: string }> = []
    const delegateRuntime = runtime(async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' ? response({ content: '# skill' }) : response({ content: 'done' })
    })
    const callContext: DelegateAgentCallContext = {
      parentPath: 'root',
      parentTranscript: 'root transcript',
      progress() {},
      async writeTextFile(input) {
        writes.push(input)
        return { ok: true }
      },
    }

    await delegateRuntime.delegateAgents(
      { children: [{ objective: 'one' }, { objective: 'two' }, { objective: 'three' }] },
      callContext,
    )
    await delegateRuntime.dispose?.()

    const skillIndexWrites = writes.filter((write) => write.path.endsWith('/index/skills.jsonl'))
    const agentIndexWrites = writes.filter((write) => write.path.endsWith('/index/agents.jsonl'))
    const runIndexRecords = writes
      .filter((write) => write.path.endsWith('/index/runs.jsonl'))
      .flatMap((write) => write.content.trim().split('\n').map((line) => JSON.parse(line)))
    const eventWrites = writes.filter((write) => write.path.endsWith('/events.jsonl'))
    expect(skillIndexWrites).toHaveLength(1)
    expect(skillIndexWrites[0].content.trim().split('\n')).toHaveLength(4)
    expect(agentIndexWrites).toHaveLength(1)
    expect(agentIndexWrites[0].content.trim().split('\n')).toHaveLength(4)
    expect(runIndexRecords.map((record) => record.status)).toEqual(['running', 'delegated'])
    expect(runIndexRecords[1].updatedAt >= runIndexRecords[0].updatedAt).toBe(true)
    expect(eventWrites.length).toBeGreaterThan(4)
    expect(eventWrites.every((write) => write.content.trim().split('\n').length === 1)).toBe(true)
  })

  it('retries archive initialization after the first write failure', async () => {
    let failedOnce = false
    let conversationWrites = 0
    const delegateRuntime = runtime(async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' ? response({ content: '# skill' }) : response({ content: 'done' })
    })
    const retryContext: DelegateAgentCallContext = {
      parentPath: 'root',
      progress() {},
      async writeTextFile(input) {
        if (input.path.endsWith('/conversation.json')) {
          conversationWrites += 1
          if (!failedOnce) {
            failedOnce = true
            return { ok: false, error: 'temporary failure' }
          }
        }
        return { ok: true }
      },
    }

    await expect(
      delegateRuntime.delegateAgents({ children: [{ objective: 'first' }] }, retryContext),
    ).rejects.toThrow('temporary failure')
    const result = await delegateRuntime.delegateAgents({ children: [{ objective: 'retry' }] }, retryContext)

    expect(result.children[0].status).toBe('done')
    expect(conversationWrites).toBe(2)
    delegateRuntime.dispose?.()
  })
})
