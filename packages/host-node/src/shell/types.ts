// shell 域共用的形状：上限常量、结果载荷、shell 规格、setup 失败
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_types.rs。常量的数值逐个对齐，注释里的理由也照搬——
// 它们不是随手挑的，改动前先看懂原注释。
//
// Rust 侧还有 `WAIT_POLL_INTERVAL_MS`（10ms），本移植**没有对应物**：那是给
// `try_wait()` 轮询循环用的，而 Node 的子进程退出是 `'exit'` 事件、管道读完是 promise
// resolve，两处都不需要轮询。少一个常量不是漏移植，是这一层根本不存在。

/** 输出上限的默认值与硬顶（按 Unicode 码点算，见 workspace/common/readCapped.ts）。 */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000
export const MAX_OUTPUT_CHARS = 100_000

/** 超时的默认值与硬顶。 */
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 120_000

// 直接子进程退出后，残留在管道里的输出只有一个管道缓冲区那么多，读完是微秒级的；
// 留 500ms 是给调度的余量，正常命令不会等满（读完即返回）。
export const ORPHAN_DRAIN_GRACE_MS = 500
// 杀掉进程组到写端真正关闭之间同样只需调度余量。
export const ORPHAN_KILL_GRACE_MS = 500

/**
 * `run_shell_command` 的返回载荷。
 *
 * **键名是 snake_case**：Rust 的 `ShellCommandResult` 只 derive 了 `Serialize`、没有
 * `rename_all`，所以字段按 Rust 的写法原样上线，桌面端今天收到的就是这一套键。core 的
 * `normalizeResult`（runtime/shellCommand.ts）两种口径都认（`raw.timedOut ?? raw.timed_out`），
 * 但两个宿主返回不同的键会让「对拍」变成一件要先做映射的事，没有好处。
 */
export interface ShellCommandResultPayload {
  platform: string
  shell: string
  command: string
  cwd: string
  /**
   * 进程被信号杀死时为 `null`（Rust 的 `ExitStatus::code()` 在 Unix 上同样返回 `None`）。
   * core 侧会把它整形成 `exitCode: -1` 并在 stderr 追加一句说明——那是**既有语义**，
   * 不是本移植的选择：超时被 SIGKILL 的命令在桌面端今天就是这个表现。
   */
  exit_code: number | null
  stdout: string
  stderr: string
  duration_ms: number
  timed_out: boolean
  truncated: boolean
  /**
   * 命令留下了仍持有 stdout/stderr 的后台进程，它们已被强制清理。
   * 调用方据此知道 `cmd &` 起的服务并没有活下来。
   */
  background_processes_killed: boolean
}

/** 宿主 shell 的启动规格。`display` 是回显给调用方的那一行（也用于 spawn 失败的错误文案）。 */
export interface ShellSpec {
  program: string
  args: readonly string[]
  display: string
}

/**
 * **准备阶段**的失败：平台不支持、cwd 不可用、shell 起不来。
 *
 * 它与「桥调用失败」是两件事，Rust 用返回类型分开了：准备阶段的错误走
 * `Ok(failed_result(...))`——一次 `exit_code: 1`、stderr 写着原因的**正常结果**；
 * 而读管道失败之类走 `Err(String)`，到 core 那边变成 `run_shell_command failed: …`。
 * TS 里两者都是「抛出来的东西」，所以准备阶段的失败必须能被认出来：pipeline 只捕获
 * 本类型，其余一律继续抛，免得把真正的 bug 也整形成「命令跑完了，退出码 1」。
 */
export class ShellSetupError extends Error {
  override readonly name = 'ShellSetupError'
}
