// `run_workspace_task` 的 handler：入参收窄 → 解析 kind/root/task → 起子进程 → 收尾成结果
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_task.rs 的 `run_workspace_task_blocking`（顶层编排）、
// `ensure_workspace_dir`、`normalize_timeout_ms`、`normalize_max_output_chars`、`failed_result`。
//
// 【两种失败的分界，逐条对齐 Rust】
// kind 非法 / workspace root 解析失败 / root 不是目录 / 找不到对应任务 / 起子进程失败——这五处
// Rust 用 `Ok(failed_result(...))` 把失败**包成一个正常的 `WorkspaceTaskResult`**（`ok: false`），
// 调用方看到的是「任务跑了但失败」，不是「调用本身炸了」。本文件同样在这五处 `return` 一个对象，
// 不 `throw`。
// 再往后（拿不到 stdout/stderr 句柄、等子进程出错、读输出出错）Rust 用 `?` 直接让整个 Tauri
// 命令失败——这是「不该发生的宿主级故障」，不是「任务失败」，本文件同样在这些点 `throw`，
// 让它们变成 handler 的 rejection，而不是包成 `ok: false` 的正常结果。
//
// 【何时用中文 / 英文报错，见 CLAUDE.md「错误文案跟随 Rust 保持英文原文」】
// kind / root / task 解析失败的消息全部来自 resolveTask.ts / common 的 resolveWorkspaceRoot /
// taskKind.ts——它们逐字对齐 Rust，英文。`kind` 参数整个缺失（或类型不对）是 Node 独有的失败面：
// Tauri 那边这种情况在**反序列化**阶段就会被挡下，根本进不到 `run_workspace_task_blocking`，
// Rust 源码里找不到对应文案；HTTP 传输下 `args` 是外部输入，必须自己挡，挡下时用中文。

import { stat } from 'node:fs/promises'
import { errorText, resolveWorkspaceRoot } from '../common'
import { resolveTask, taskCommand } from './resolveTask'
import { spawnTask, waitForChild } from './taskProcess'
import { readWorkspaceTaskOutput } from './readWorkspaceTaskOutput'
import { parseTaskKind } from './taskKind'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_CHARS = 20_000
const MAX_OUTPUT_CHARS = 100_000

interface RunWorkspaceTaskArgs {
  kind: string
  timeoutMs?: number
  maxOutputChars?: number
  workspaceRoot?: string
}

interface WorkspaceTaskResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  command: string[]
  cwd: string
  kind: string
}

/**
 * 收窄外部入参。顶层键是 snake_case（Rust 侧 `rename_all = "snake_case"`），core 的
 * `toTauriInput` 已经转好，`args` 拿到的就是这个大小写——不要在这里再转一次。
 * 判缺席只看值（`!== undefined`），不用 `'key' in args`：见 commandArgs.ts 文件头。
 */
function parseArgs(args: Record<string, unknown>): RunWorkspaceTaskArgs {
  const kind = args.kind
  if (typeof kind !== 'string') throw new Error('run_workspace_task 缺少 kind 参数')

  const timeoutMs = args.timeout_ms
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
    throw new Error('run_workspace_task 的 timeout_ms 必须是数字')
  }
  const maxOutputChars = args.max_output_chars
  if (maxOutputChars !== undefined && typeof maxOutputChars !== 'number') {
    throw new Error('run_workspace_task 的 max_output_chars 必须是数字')
  }
  const workspaceRoot = args.workspace_root
  if (workspaceRoot !== undefined && typeof workspaceRoot !== 'string') {
    throw new Error('run_workspace_task 的 workspace_root 必须是字符串')
  }

  return { kind, timeoutMs, maxOutputChars, workspaceRoot }
}

function normalizeTimeoutMs(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.min(value, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
}

function normalizeMaxOutputChars(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.min(value, MAX_OUTPUT_CHARS) : DEFAULT_MAX_OUTPUT_CHARS
}

async function ensureWorkspaceDir(root: string): Promise<void> {
  let stats
  try {
    stats = await stat(root)
  } catch (error) {
    throw new Error(`workspace root \`${root}\` is not accessible: ${errorText(error)}`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`workspace root \`${root}\` is not a directory`)
  }
}

function failedResult(
  kind: string,
  command: string[],
  cwd: string,
  stderr: string,
  startedAt: number,
): WorkspaceTaskResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    truncated: false,
    command,
    cwd,
    kind,
  }
}

export function createRunWorkspaceTaskHandler(_options: NodeHostInvokeOptions): NodeHostCommandHandler {
  return async (rawArgs): Promise<WorkspaceTaskResult> => {
    const startedAt = Date.now()
    const args = parseArgs(rawArgs)
    const kindInput = args.kind.trim()

    let taskKind
    try {
      taskKind = parseTaskKind(kindInput)
    } catch (error) {
      return failedResult(kindInput, [], '', errorText(error), startedAt)
    }
    const kind: string = taskKind

    let root: string
    try {
      root = await resolveWorkspaceRoot(args.workspaceRoot)
    } catch (error) {
      return failedResult(kind, [], '', errorText(error), startedAt)
    }

    try {
      await ensureWorkspaceDir(root)
    } catch (error) {
      return failedResult(kind, [], root, errorText(error), startedAt)
    }

    const cwd = root
    let task
    try {
      task = await resolveTask(root, taskKind)
    } catch (error) {
      return failedResult(kind, [], cwd, errorText(error), startedAt)
    }

    const command = taskCommand(task)
    const timeoutMs = normalizeTimeoutMs(args.timeoutMs)
    const maxOutputChars = normalizeMaxOutputChars(args.maxOutputChars)

    let child
    try {
      child = await spawnTask(task, root)
    } catch (error) {
      return failedResult(kind, command, cwd, errorText(error), startedAt)
    }

    // 从这里开始，失败一律 throw（宿主级故障），不再包成 WorkspaceTaskResult——见文件头说明。
    if (!child.stdout || !child.stderr) {
      throw new Error(`failed to capture task ${child.stdout ? 'stderr' : 'stdout'}`)
    }

    // 必须先发起输出读取、再 await 等子进程退出：两路读取要与「等子进程」并发进行，否则
    // 管道缓冲区写满会把子进程卡死在写系统调用里，见 readWorkspaceTaskOutput.ts 的说明。
    const outputPromise = readWorkspaceTaskOutput(child.stdout, child.stderr, maxOutputChars)
    const { exitCode, timedOut } = await waitForChild(child, timeoutMs)
    const durationMs = Date.now() - startedAt
    const { stdout, stderr } = await outputPromise

    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
      command,
      cwd,
      kind,
    }
  }
}
