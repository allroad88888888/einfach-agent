import { describe, expect, it } from 'vitest'
import { createDelegateAgentRuntime, createSubagentScheduler } from '@einfach-agent/subagents'
import { SubagentArchiveIO } from './archiveIO'
import {
  agentPathDepth,
  normalizeDelegateAgentInput,
  type DelegateAgentCallContext,
  type SubagentNodeRecord,
} from '@einfach-agent/core/subagents'
import { measureSubagentArchiveCapacity, type SubagentArchiveCapacityMeasurement } from './archiveCapacity'

const archiveBasePath = '.webAgent-archive/conversations/capacity-session/runs/capacity-run'

class ArchiveHost {
  private readonly chunks = new Map<string, string[]>()

  async write(input: { path: string; content: string; mode?: string }): Promise<{ ok: true }> {
    if (input.mode === 'append') {
      const chunks = this.chunks.get(input.path) ?? []
      chunks.push(input.content)
      this.chunks.set(input.path, chunks)
    } else {
      this.chunks.set(input.path, [input.content])
    }
    return { ok: true }
  }

  files(): Array<{ path: string; content: string }> {
    return [...this.chunks].map(([path, chunks]) => ({ path, content: chunks.join('') }))
  }
}

function context(host: ArchiveHost): DelegateAgentCallContext {
  return {
    parentPath: 'root',
    parentTranscript: 'capacity baseline transcript',
    progress() {},
    writeTextFile: (input) => host.write(input),
  }
}

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function reportCapacity(label: string, measurement: SubagentArchiveCapacityMeasurement): void {
  if (process.env.SUBAGENT_CAPACITY_REPORT === '1') {
    console.info(`[subagent-capacity] ${label} ${JSON.stringify(measurement)}`)
  }
}

function isChildRequest(init?: RequestInit): boolean {
  const body = JSON.parse(String(init?.body)) as {
    messages: Array<{ content?: unknown }>
  }
  return typeof body.messages[0]?.content === 'string'
    && body.messages[0].content.includes('树形子 agent')
}

function maximumTreeNodes(): SubagentNodeRecord[] {
  const normalized = normalizeDelegateAgentInput({
    children: [{ objective: 'seed' }],
    maxDepth: 6,
    maxChildren: 12,
    maxConcurrent: 8,
    maxTotalNodes: 256,
    maxModelCalls: 512,
  })
  if (!normalized.ok) throw new Error(normalized.error)

  const { maxChildren, maxDepth, maxTotalNodes } = normalized.input
  if (!maxChildren || !maxDepth || !maxTotalNodes) {
    throw new Error('capacity baseline requires normalized tree limits')
  }
  const scheduler = createSubagentScheduler()
  const queue = ['root']
  let used = 1
  let sequence = 0

  while (used < maxTotalNodes) {
    const parentPath = queue.shift()
    if (!parentPath) throw new Error('capacity tree could not reach the configured node limit')
    if (agentPathDepth(parentPath) >= maxDepth) continue
    const childCount = Math.min(maxChildren, maxTotalNodes - used)
    const children = Array.from({ length: childCount }, () => ({
      objective: `capacity node ${String(++sequence).padStart(3, '0')}`,
    }))
    const reserved = scheduler.reserveChildren({
      treeId: 'capacity-run',
      sessionId: 'capacity-session',
      parentPath,
      inheritedSkillFiles: [],
      inheritedSkillIds: [],
      children,
    })
    used += reserved.length
    queue.push(...reserved.map((node) => node.path))
  }

  const nodes = scheduler.snapshot('capacity-run')
  scheduler.clear('capacity-run')
  return nodes
}

describe('subagent archive capacity baselines', () => {
  it('materializes a repeatable 10,000-event long-session archive', async () => {
    const host = new ArchiveHost()
    const archive = new SubagentArchiveIO({
      writerContext: { queueKey: {} },
      sessionId: 'capacity-session',
      runId: 'capacity-run',
      model: 'deepseek-v4-pro',
      vendor: 'deepseek',
    })
    const callContext = context(host)
    await archive.ensureArchiveInitialized(callContext, archiveBasePath)

    for (let index = 0; index < 10_000; index += 1) {
      await archive.recordEvent(callContext, archiveBasePath, 'child_finished', 'root-01', {
        status: 'done',
        sequence: index,
      })
    }
    await archive.close()

    const measurement = measureSubagentArchiveCapacity({ files: host.files() })
    reportCapacity('long-session', measurement)
    expect(measurement).toMatchObject({
      fileCount: 4,
      eventCount: 10_001,
      nodeStatePayloadBytes: 2,
    })
  })

  it('materializes the current 256-node hard-limit tree without changing audit history', async () => {
    const host = new ArchiveHost()
    const nodes = maximumTreeNodes()
    const archive = new SubagentArchiveIO({
      writerContext: { queueKey: {} },
      sessionId: 'capacity-session',
      runId: 'capacity-run',
      model: 'deepseek-v4-pro',
      vendor: 'deepseek',
    })
    const callContext = context(host)
    await archive.ensureArchiveInitialized(callContext, archiveBasePath)
    await archive.persistTreeSnapshot(callContext, archiveBasePath, nodes)
    await archive.close()

    const measurement = measureSubagentArchiveCapacity({ files: host.files(), nodes })
    reportCapacity('hard-limit-tree', measurement)
    expect(nodes).toHaveLength(256)
    expect(measurement).toMatchObject({ fileCount: 262, eventCount: 2 })
    expect(measurement.archiveBytes).toBeGreaterThan(measurement.nodeStatePayloadBytes)
    expect(measurement.indexBytes).toBeGreaterThan(0)
  })

  it('caps a 12-child runtime batch at eight simultaneous child model requests', async () => {
    const host = new ArchiveHost()
    const seenNodes = new Map<string, SubagentNodeRecord>()
    let activeChildRequests = 0
    let peakChildRequests = 0
    let releaseFirstWave: () => void = () => {}
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve
    })
    const runtime = createDelegateAgentRuntime({
      sessionId: 'capacity-session',
      runId: 'capacity-run',
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl: async (_url, init) => {
        if (!isChildRequest(init)) return response({ role: 'assistant', content: '# distilled skill' })
        activeChildRequests += 1
        peakChildRequests = Math.max(peakChildRequests, activeChildRequests)
        if (activeChildRequests === 8) releaseFirstWave()
        await firstWave
        activeChildRequests -= 1
        return response({ role: 'assistant', content: 'done' })
      },
      onNodeChange: (node) => seenNodes.set(node.path, node),
    })

    const result = await runtime.delegateAgents({
      children: Array.from({ length: 12 }, (_, index) => ({ objective: `concurrent child ${index + 1}` })),
      maxChildren: 12,
      maxConcurrent: 8,
      maxTotalNodes: 256,
      maxModelCalls: 512,
    }, context(host))
    await runtime.dispose?.()

    const measurement = measureSubagentArchiveCapacity({
      files: host.files(),
      nodes: [...seenNodes.values()],
    })
    reportCapacity('concurrent-batch', measurement)
    expect(result.summary).toEqual({ total: 12, done: 12, failed: 0, cancelled: 0 })
    expect(peakChildRequests).toBe(8)
    expect(measurement.nodeStatePayloadBytes).toBeGreaterThan(0)
    expect(measurement.eventCount).toBeGreaterThan(12)
  })
})
