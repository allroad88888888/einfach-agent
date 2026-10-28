// shell 命令执行的主流程：校验平台、起子进程、等待/超时、收尾输出
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_pipeline.rs（已随 T1 删除）的 `run_shell_command_blocking`。
//
// 【失败分两种，别塌成一种】
// 准备阶段的失败（平台不支持 / 平台不符 / 没有可用 shell / cwd 不可用 / shell 起不来）在
// Rust 里都是 `Ok(failed_result(...))`：一次 `exit_code: 1`、stderr 写着原因的**正常结果**。
// 模型据此知道「命令没跑成，原因是这个」，而不是看到一句宿主异常。执行期的失败（读管道
// 出错、超时后杀不掉）才是 `Err`，到 core 那边变成 `run_shell_command failed: …`。
// 这里靠 `ShellSetupError` 区分：只有它被整形成结果，其余一律继续抛。
//
// 【failed_result 的字段随进度变化】
// 走到哪一步失败，`shell` 和 `cwd` 就回显到哪一步的值：还没选出 shell 时是 `"unavailable"`，
// cwd 还没 canonicalize 时回显调用方给的原字符串。逐条对齐 Rust 的五个分支。

import { createActivityPulse } from './activity'
import { drainOutputReaders } from './drain'
import { captureOutput, type OutputCapture } from './outputCapture'
import { currentPlatform, parsePlatform, resolveCwd, resolveShell } from './platform'
import { spawnShellCommand } from './spawn'
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  MAX_TIMEOUT_MS,
  MAX_TOTAL_MS,
  ShellSetupError,
  type ShellCommandResultPayload,
  type ShellSpec,
} from './types'
import { waitForChild } from './wait'

/** 已经收窄过的一次请求。字段名是 Node 侧的驼峰，线上 snake_case 的转换在 runShellCommand.ts。 */
export interface ShellCommandRequest {
  platform: string
  command: string
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
  env?: Record<string, string>
}

export async function executeShellCommand(
  request: ShellCommandRequest,
): Promise<ShellCommandResultPayload> {
  const startedAt = performance.now()
  const cwdInput = request.cwd ?? ''
  // 三个「失败时回显什么」的游标，随准备阶段推进逐个落定。
  let platform = request.platform
  let shellDisplay = 'unavailable'
  let cwdDisplay = cwdInput

  try {
    const requested = parsePlatform(request.platform)
    platform = requested
    const current = currentPlatform()
    if (requested !== current) {
      throw new ShellSetupError(
        `platform mismatch: requested \`${requested}\`, current \`${current}\``,
      )
    }
    const shell = await resolveShell(requested)
    shellDisplay = shell.display
    const cwdPath = await resolveCwd(cwdInput === '' ? undefined : cwdInput)
    cwdDisplay = cwdPath
    return await runResolved(request, requested, shell, cwdPath, startedAt)
  } catch (error) {
    if (!(error instanceof ShellSetupError)) throw error
    return failedResult({
      platform,
      shell: shellDisplay,
      command: request.command,
      cwd: cwdDisplay,
      stderr: error.message,
      startedAt,
    })
  }
}

/** 平台、shell、cwd 都已落定之后的执行段。 */
async function runResolved(
  request: ShellCommandRequest,
  platform: string,
  shell: ShellSpec,
  cwd: string,
  startedAt: number,
): Promise<ShellCommandResultPayload> {
  const timeoutMs = normalizeTimeoutMs(request.timeoutMs)
  const maxOutputChars = normalizeMaxOutputChars(request.maxOutputChars)
  const spawned = await spawnShellCommand(shell, request.command, cwd, request.env)

  // 两条流的读取在等待退出**之前**就开始：管道缓冲只有几十 KiB，等进程退出再读的话，
  // 输出稍多的命令会卡在 write 上永远退不出来。
  //
  // 两路都往同一个活性脉冲里发：判断「命令还活着」看的是「有没有任一条流在动」，
  // stdout 与 stderr 分开计时没有意义，`2>&1` 与分开重定向都该一视同仁。
  const pulse = createActivityPulse()
  const markActivity = () => pulse.touch()
  const stdout = captureOutput(spawned.stdout, 'stdout', maxOutputChars, markActivity)
  const stderr = captureOutput(spawned.stderr, 'stderr', maxOutputChars, markActivity)

  try {
    const exit = await waitForChild(spawned.child, {
      idleMs: timeoutMs,
      totalMs: MAX_TOTAL_MS,
      pulse,
    })
    const backgroundProcessesKilled = await drainOutputReaders(spawned.child, [stdout, stderr])
    const capturedOut = stdout.take()
    const capturedErr = stderr.take()

    return {
      platform,
      shell: shell.display,
      command: request.command,
      cwd,
      exit_code: exit.exitCode,
      stdout: capturedOut.text,
      stderr: capturedErr.text,
      duration_ms: millisSince(startedAt),
      timed_out: exit.timedOut,
      // 只在真的超时时带键：`undefined` 在进程内注入时是「键在、值是 undefined」，
      // 走 HTTP 时被 JSON.stringify 丢掉（runShellCommand.ts 文件头记录过这个差异）。
      // core 的 normalizeResult 两种都当成「没有」处理。
      timeout_reason: exit.timeoutReason,
      truncated: capturedOut.truncated || capturedErr.truncated,
      background_processes_killed: backgroundProcessesKilled,
    }
  } catch (error) {
    // Rust 的失败路径靠 drop 关掉管道；Node 的 Readable 不会自己消失，还活着的流会一直
    // 拿着 fd 和一个 event loop handle——CLI 宿主会因此在命令失败后拒绝退出。
    releaseCaptures([stdout, stderr])
    throw error
  }
}

function releaseCaptures(captures: readonly OutputCapture[]): void {
  for (const capture of captures) {
    if (!capture.settled) capture.abandon()
  }
}

interface FailedResultInput {
  platform: string
  shell: string
  command: string
  cwd: string
  stderr: string
  startedAt: number
}

/** 准备阶段失败的结果形状：退出码固定 1、stderr 写原因、其余字段全是「没发生过」。 */
function failedResult(input: FailedResultInput): ShellCommandResultPayload {
  return {
    platform: input.platform,
    shell: input.shell,
    command: input.command,
    cwd: input.cwd,
    exit_code: 1,
    stdout: '',
    stderr: input.stderr,
    duration_ms: millisSince(input.startedAt),
    timed_out: false,
    truncated: false,
    background_processes_killed: false,
  }
}

/** 缺省、非法（非有限数 / ≤ 0）一律回默认值；超过硬顶则封顶。对齐 Rust 的 `normalize_timeout_ms`。
 *
 * 数值规则沿用原实现，但**语义已经变了**：这个数现在是「允许的最长静默时长」，不是墙钟上限。
 * 见 types.ts 的 `DEFAULT_TIMEOUT_MS` 注释。
 */
function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS)
}

function normalizeMaxOutputChars(maxOutputChars: number | undefined): number {
  if (
    typeof maxOutputChars !== 'number' ||
    !Number.isFinite(maxOutputChars) ||
    maxOutputChars <= 0
  ) {
    return DEFAULT_MAX_OUTPUT_CHARS
  }
  return Math.min(Math.floor(maxOutputChars), MAX_OUTPUT_CHARS)
}

/**
 * 已经过去多少毫秒。用 `performance.now()` 而不是 `Date.now()`：后者会跟着系统时钟跳
 * （NTP 校时、夏令时），一次 200ms 的命令能报出负数或几小时。Rust 用的 `Instant` 同样是单调钟。
 */
function millisSince(startedAt: number): number {
  return Math.max(0, Math.floor(performance.now() - startedAt))
}
