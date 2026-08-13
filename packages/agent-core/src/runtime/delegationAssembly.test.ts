import { describe, expect, it, vi } from 'vitest'
import { registerAgentsTools } from '@web-agent/tools-agents'
import { createSubagentScheduler } from '@web-agent/subagents'
import type { ExecutionHandle } from '../execution/types'
import { sessionsAtom } from '../state/rootStore'
import { setRun } from '../state/sessionWriters'
import type {
  DelegateAgentBatchResult,
  DelegationRuntime,
  DelegationRuntimeFactory,
} from './delegationContract'
import { createCore } from './core/createCore'
import { buildToolContext } from './toolContext'

const unavailableError = '子 Agent 委派能力不可用：当前运行环境未注入委派执行器。'

function seedRunningSession(
  core: ReturnType<typeof createCore>,
  id = 'delegation-session',
  runId = 'delegation-run',
): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'delegation test',
      settings: { vendor: 'deepseek', model: 'test-model' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
  setRun(id, { runId, status: 'running' }, core)
}

function delegateContext(
  core: ReturnType<typeof createCore>,
  delegateRuntime?: DelegationRuntime,
) {
  return buildToolContext({
    sessionId: 'delegation-session',
    runId: 'delegation-run',
    signal: new AbortController().signal,
    callId: 'delegate-call',
    toolName: 'delegate_agent',
    delegateRuntime,
    core,
  })
}

describe('delegation capability assembly', () => {
  it('未注入 delegation 时，独立 Core 的 delegate_agent 返回不可用错误', async () => {
    const core = createCore({ registerTools: registerAgentsTools })
    seedRunningSession(core)
    const ctx = delegateContext(core)

    expect(ctx.delegateAgents).toBeUndefined()
    await expect(core.tools.run('delegate_agent', {
      children: [{ objective: '验证未注入能力' }],
    }, ctx)).resolves.toEqual({
      ok: false,
      error: unavailableError,
      code: 'AGENT_DELEGATION_UNAVAILABLE',
      retryable: false,
    })
  })

  it('routes an independent Core fake delegation runtime through ToolContext', async () => {
    const batch: DelegateAgentBatchResult = {
      treeId: 'fake-tree',
      conversationId: 'delegation-session',
      runId: 'delegation-run',
      parentPath: 'root',
      strategy: 'parallel_wait_all',
      status: 'done',
      summary: { total: 1, done: 1, failed: 0, cancelled: 0 },
      cacheBasePath: '.cache',
      archiveBasePath: '.archive',
      eventLog: '.archive/events.jsonl',
      skillFiles: [],
      skillIds: [],
      children: [],
    }
    const runtime: DelegationRuntime = {
      async delegateAgents() { return batch },
    }
    const delegateAgents = vi.spyOn(runtime, 'delegateAgents')
    const createRuntime = vi.fn(async (): Promise<DelegationRuntime> => runtime)
    const delegation: DelegationRuntimeFactory = () => ({
      scheduler: createSubagentScheduler(),
      createRuntime,
    })
    const core = createCore({ delegation, registerTools: registerAgentsTools })
    seedRunningSession(core)

    const delegateRuntime = await core.delegation!.createRuntime({
      sessionId: 'delegation-session',
      runId: 'delegation-run',
      settings: { vendor: 'deepseek', model: 'test-model' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
    })
    const ctx = delegateContext(core, delegateRuntime)
    const result = await core.tools.run('delegate_agent', {
      children: [{ objective: '委派给 fake runtime' }],
    }, ctx)

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'delegation-session',
      runId: 'delegation-run',
    }))
    expect(delegateAgents).toHaveBeenCalledWith(
      expect.objectContaining({ children: [{ objective: '委派给 fake runtime' }] }),
      expect.objectContaining({ parentPath: 'root', delegationCallId: 'delegate-call' }),
    )
    expect(result).toMatchObject({ ok: true, data: { status: 'scheduled' } })
    const handle = (result as { data: ExecutionHandle }).data
    await expect(ctx.joinExecution!(handle.executionId)).resolves.toMatchObject({
      status: 'succeeded',
      result: batch,
    })
  })
})
