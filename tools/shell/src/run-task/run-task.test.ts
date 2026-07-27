import { describe, it, expect, vi } from 'vitest'
import type { ToolContext, WorkspaceTaskInput, WorkspaceTaskResult } from '@web-agent/core/tools/types'
import { runTaskTool } from './run-task'

type TestToolContext = ToolContext & {
  runWorkspaceTask(input: WorkspaceTaskInput): Promise<WorkspaceTaskResult>
}

function makeCtx(
  runWorkspaceTask: TestToolContext['runWorkspaceTask'] = vi.fn(async () => ({
    ok: true,
    kind: 'test',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
    command: ['npm', 'run', 'test'],
    cwd: '/workspace',
  })),
): TestToolContext {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(async (input) => ({
      platform: input.platform,
      shell: 'test',
      command: input.command,
      cwd: input.cwd ?? '',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
    })),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    runWorkspaceTask,
  }
}

describe('run_task tool', () => {
  it('schema 只暴露预定义任务和两个可选限制参数', () => {
    expect(runTaskTool.name).toBe('run_task')
    expect(runTaskTool.runtime).toBe('server')
    expect(runTaskTool.inputSchema).toMatchObject({
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['test', 'build', 'lint', 'typecheck', 'cargo_check'] },
        timeoutMs: { minimum: 1 },
        maxOutputChars: { minimum: 1 },
      },
    })
    expect(runTaskTool.skill.content.length).toBeGreaterThan(0)
  })

  it('ctx 未接 runWorkspaceTask → {ok:false,error}', async () => {
    const ctx = makeCtx()
    delete (ctx as Partial<TestToolContext>).runWorkspaceTask

    const result = await runTaskTool.execute({ kind: 'test' }, ctx)

    expect(result).toEqual({
      ok: false,
      error: 'run_task unavailable: ctx.runWorkspaceTask is not configured',
      code: 'TASK_UNAVAILABLE',
      retryable: false,
    })
  })

  it('合法参数 → ctx.runWorkspaceTask 被调用，返回 {ok:true,data}', async () => {
    const taskResult = {
      ok: true,
      kind: 'test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      truncated: false,
      command: ['npm', 'run', 'test'],
      cwd: '/workspace',
    }
    const runWorkspaceTask = vi.fn(async () => taskResult)
    const ctx = makeCtx(runWorkspaceTask)

    const result = await runTaskTool.execute(
      { kind: ' test ', timeoutMs: 1000, maxOutputChars: 5000 },
      ctx,
    )

    expect(runWorkspaceTask).toHaveBeenCalledWith({
      kind: 'test',
      timeoutMs: 1000,
      maxOutputChars: 5000,
    })
    expect(result).toEqual({ ok: true, data: taskResult })
  })

  it('任务失败返回外层结构化失败', async () => {
    const taskResult: WorkspaceTaskResult = {
      ok: false,
      kind: 'test',
      exitCode: 1,
      stdout: '',
      stderr: 'tests failed',
      durationMs: 12,
      timedOut: false,
      truncated: false,
      command: ['npm', 'run', 'test'],
      cwd: '/workspace',
    }
    const result = await runTaskTool.execute(
      { kind: 'test' },
      makeCtx(vi.fn(async () => taskResult)),
    )
    expect(result).toMatchObject({
      ok: false,
      code: 'TASK_FAILED',
      retryable: false,
      details: taskResult,
    })
  })
})
