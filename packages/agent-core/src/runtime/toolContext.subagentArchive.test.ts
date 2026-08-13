import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspaceWrite', () => ({ writeWorkspaceFile: vi.fn() }))

import { rootStore, sessionsAtom } from '../state/rootStore'
import { setRun } from '../state/sessionWriters'
import type {
  DelegateAgentCallContext,
  DelegateAgentRuntime,
  SubagentArchiveWriteMode,
} from '../subagents/types'
import { buildToolContext } from './toolContext'
import { writeWorkspaceFile, type WorkspaceWriteInput, type WorkspaceWriteResult } from './workspaceWrite'

afterEach(() => {
  vi.clearAllMocks()
})

function seedRunningSession(): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    s1: {
      id: 's1',
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      workspaceRoot: '/workspace',
      createdAt: 0,
      updatedAt: 0,
    },
  }))
  setRun('s1', { runId: 'r1', status: 'running' })
}

function writeResult(
  input: WorkspaceWriteInput,
  values: Partial<WorkspaceWriteResult> = {},
): WorkspaceWriteResult {
  return {
    ok: true,
    path: input.path,
    bytesWritten: input.content.length,
    created: input.mode === 'create',
    overwritten: input.mode === 'overwrite',
    appended: input.mode === 'append',
    ...values,
  }
}

function contextWriting(input: { path: string; content: string; mode?: SubagentArchiveWriteMode }): {
  runtime: DelegateAgentRuntime
  result: () => unknown
} {
  let result: unknown
  return {
    runtime: {
      async delegateAgents(_delegateInput, context: DelegateAgentCallContext) {
        result = await context.writeTextFile!(input)
        return {
          treeId: 'tree',
          conversationId: 's1',
          runId: 'r1',
          parentPath: '0',
          strategy: 'parallel_wait_all',
          status: 'done',
          summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
          cacheBasePath: '.cache',
          archiveBasePath: '.archive',
          eventLog: '.archive/events.jsonl',
          skillFiles: [],
          skillIds: [],
          children: [],
        }
      },
    },
    result: () => result,
  }
}

async function delegate(
  runtime: DelegateAgentRuntime,
  opts: { signal?: AbortSignal; runId?: string; toolName?: string } = {},
): Promise<void> {
  seedRunningSession()
  const ctx = buildToolContext({
    sessionId: 's1',
    runId: opts.runId ?? 'r1',
    signal: opts.signal ?? new AbortController().signal,
    callId: 'call1',
    toolName: opts.toolName ?? 'delegate_agent',
    delegateRuntime: runtime,
  })
  await ctx.delegateAgents!({ children: [{ objective: 'write archive' }] })
}

describe('toolContext 子 Agent 归档写入', () => {
  it('归档 snapshot 用 upsert 一次落盘：不存在则新建、已存在则覆盖，且不再有探测往返', async () => {
    let exists = false
    vi.mocked(writeWorkspaceFile).mockImplementation(async (input) => {
      const created = !exists
      exists = true
      return writeResult(input, { created, overwritten: !created })
    })
    const first = contextWriting({ path: '.archive/tree.json', content: 'first' })

    await delegate(first.runtime)

    expect(first.result()).toMatchObject({ ok: true, created: true })
    // 关键：首次落盘也只有一次写调用。旧实现要先 overwrite 失败再 create。
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.archive/tree.json',
        mode: 'upsert',
        createDirs: true,
        exclusivePathLock: true,
        workspaceRoot: '/workspace',
      }),
      expect.anything(),
    )

    vi.mocked(writeWorkspaceFile).mockClear()
    const second = contextWriting({ path: '.archive/tree.json', content: 'second' })
    await delegate(second.runtime)

    expect(second.result()).toMatchObject({ ok: true, overwritten: true })
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '.archive/tree.json', content: 'second', mode: 'upsert' }),
      expect.anything(),
    )
  })

  it('workspace writer 返回 ok:false 时显式抛错，包括非 Tauri fallback', async () => {
    vi.mocked(writeWorkspaceFile).mockImplementation(async (input) =>
      writeResult(input, {
        ok: false,
        bytesWritten: 0,
        appended: false,
        error: 'Workspace file writing is only available in the Tauri desktop runtime',
      }),
    )
    const attempt = contextWriting({ path: '.archive/events.jsonl', content: '{}\n', mode: 'append' })

    await expect(delegate(attempt.runtime)).rejects.toThrow(
      'Subagent archive write failed (append) for ".archive/events.jsonl": Workspace file writing is only available in the Tauri desktop runtime',
    )
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
  })

  it('阶段评估器归档不可用时跳过归档，不阻断 evaluator 与计划推进', async () => {
    vi.mocked(writeWorkspaceFile).mockImplementation(async (input) =>
      writeResult(input, {
        ok: false,
        bytesWritten: 0,
        overwritten: false,
        error: 'Workspace file writing is only available in the Tauri desktop runtime',
      }),
    )
    const attempt = contextWriting({ path: '.archive/evaluator.json', content: '{}', mode: 'overwrite' })

    await expect(delegate(attempt.runtime, { toolName: 'submit_stage_result' })).resolves.toBeUndefined()
    expect(attempt.result()).toMatchObject({
      ok: true,
      skipped: true,
      warning: expect.stringContaining('Workspace file writing is only available'),
    })
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
  })

  it('upsert 快照写入失败时不会静默继续，且不再重试第二种模式', async () => {
    vi.mocked(writeWorkspaceFile).mockImplementation(async (input) =>
      writeResult(input, {
        ok: false,
        bytesWritten: 0,
        created: false,
        overwritten: false,
        error: 'permission denied',
      }),
    )
    const attempt = contextWriting({ path: '.archive/tree.json', content: '{}' })

    await expect(delegate(attempt.runtime)).rejects.toThrow(
      'Subagent archive write failed (upsert) for ".archive/tree.json": permission denied',
    )
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
  })

  it('当前 run 已 abort 仍允许写入最终审计归档', async () => {
    vi.mocked(writeWorkspaceFile).mockImplementation(async (input) => writeResult(input))
    const controller = new AbortController()
    controller.abort()
    const attempt = contextWriting({ path: '.archive/events.jsonl', content: '{}\n', mode: 'append' })

    await expect(delegate(attempt.runtime, { signal: controller.signal })).resolves.toBeUndefined()
    expect(writeWorkspaceFile).toHaveBeenCalledOnce()
  })

  it('被新 run 顶掉的 stale run 仍拒绝写入归档', async () => {
    vi.mocked(writeWorkspaceFile).mockImplementation(async (input) => writeResult(input))
    const attempt = contextWriting({ path: '.archive/events.jsonl', content: '{}\n', mode: 'append' })

    await expect(delegate(attempt.runtime, { runId: 'old-run' })).rejects.toThrow('stale')
    expect(writeWorkspaceFile).not.toHaveBeenCalled()
  })
})
