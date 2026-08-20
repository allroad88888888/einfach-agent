// tools/run-task/run-task.ts —— safe workspace task runner. Side effects only go through ctx.
import type {
  Tool,
  ToolContext,
  WorkspaceTaskInput,
  WorkspaceTaskKind,
  WorkspaceTaskResult,
} from '@einfach-agent/core/tools'
import guide from './run-task.md?raw'

export type RunTaskKind = WorkspaceTaskKind
export type RunTaskInput = Omit<WorkspaceTaskInput, 'workspaceRoot'>

type RunTaskContext = ToolContext & {
  runWorkspaceTask(input: WorkspaceTaskInput): Promise<WorkspaceTaskResult>
}

const RUN_TASK_KINDS: RunTaskKind[] = ['test', 'build', 'lint', 'typecheck', 'cargo_check']
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 200_000

const inputSchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: RUN_TASK_KINDS,
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
    },
    maxOutputChars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_OUTPUT_CHARS,
    },
  },
  required: ['kind'],
  additionalProperties: false,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isRunTaskKind(value: string): value is RunTaskKind {
  return RUN_TASK_KINDS.includes(value as RunTaskKind)
}

function normalizeOptionalPositiveInteger(
  value: unknown,
  max: number,
  name: string,
): number | undefined | string {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return `invalid run_task: ${name} must be a positive number`
  }
  return Math.min(Math.floor(value), max)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'runWorkspaceTask failed'
}

function getRunWorkspaceTaskFromContext(ctx: ToolContext): RunTaskContext['runWorkspaceTask'] | undefined {
  const candidate = (ctx as Partial<RunTaskContext>).runWorkspaceTask
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

export const runTaskTool: Tool = {
  name: 'run_task',
  runtime: 'server', // 依赖宿主本机 workspace task runner（ctx.runWorkspaceTask），没有本机能力桥（hasHostBridge()）时不进 manifest（TP3）。
  replayUnsafe: true,
  skill: {
    description: '运行预定义的 workspace test/build/lint/typecheck/cargo_check 任务。',
    triggers: ['test', 'build', 'lint', 'typecheck', 'cargo check', '运行测试', '构建'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const kind = typeof input.kind === 'string' ? input.kind.trim() : ''
    if (!isRunTaskKind(kind)) {
      return {
        ok: false,
        error: `invalid run_task: kind must be one of ${RUN_TASK_KINDS.join(', ')}`,
        code: 'TASK_INVALID_INPUT',
        retryable: false,
      }
    }

    const timeoutMs = normalizeOptionalPositiveInteger(input.timeoutMs, MAX_TIMEOUT_MS, 'timeoutMs')
    if (typeof timeoutMs === 'string') {
      return { ok: false, error: timeoutMs, code: 'TASK_INVALID_INPUT', retryable: false }
    }
    const maxOutputChars = normalizeOptionalPositiveInteger(
      input.maxOutputChars,
      MAX_OUTPUT_CHARS,
      'maxOutputChars',
    )
    if (typeof maxOutputChars === 'string') {
      return { ok: false, error: maxOutputChars, code: 'TASK_INVALID_INPUT', retryable: false }
    }

    const runWorkspaceTask = getRunWorkspaceTaskFromContext(ctx)
    if (!runWorkspaceTask) {
      return {
        ok: false,
        error: 'run_task unavailable: ctx.runWorkspaceTask is not configured',
        code: 'TASK_UNAVAILABLE',
        retryable: false,
      }
    }

    const taskInput: RunTaskInput = { kind }
    if (timeoutMs !== undefined) taskInput.timeoutMs = timeoutMs
    if (maxOutputChars !== undefined) taskInput.maxOutputChars = maxOutputChars

    try {
      const result = await runWorkspaceTask(taskInput)
      if (!result.ok || result.timedOut || result.exitCode !== 0) {
        return {
          ok: false,
          error: result.timedOut
            ? `run_task timed out after ${result.durationMs}ms`
            : `run_task ${kind} exited with code ${result.exitCode}`,
          code: result.timedOut ? 'TASK_TIMEOUT' : 'TASK_FAILED',
          retryable: result.timedOut,
          details: result,
        }
      }
      return { ok: true, data: result }
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        code: 'TASK_EXECUTION_ERROR',
        retryable: true,
      }
    }
  },
}
