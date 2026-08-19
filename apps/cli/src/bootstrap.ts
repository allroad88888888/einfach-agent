import { createInterface } from 'node:readline/promises'
import { stdin, stdout, stderr } from 'node:process'
import { parseCliOptions, CLI_USAGE } from './cli-options'
import { requireDeepSeekCredential, resolveModelCredentials } from './credentials'
import { subscribeCliRenderer, type TextOutput } from './event-renderer'
import { renderWaitingState, resumeWaitingRun, runRepl, type ReadlineBridge } from './repl'
import { assembleCliRuntime } from './runtime'
import { installCliShutdown } from './shutdown'
import { resolveWorkspaceRoot } from './workspace-files'
import {
  defaultCore,
  newSession,
  runAtom,
  sendMessage,
  setWorkspaceRoot,
  subscribeAgentEvents,
  type RunState,
} from '@einfach-agent/core'

const output: TextOutput = { write: (text) => stdout.write(text) }

function isRunBoundary(run: RunState | undefined): run is RunState {
  return Boolean(run && ['done', 'error', 'stopped', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval'].includes(run.status))
}

function waitForRunBoundary(sessionId: string): Promise<RunState> {
  const store = defaultCore.getSessionStore(sessionId).store
  const existing = store.getter(runAtom)
  if (isRunBoundary(existing)) return Promise.resolve(existing)
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    const finish = (run: RunState): void => {
      unsubscribe()
      resolve(run)
    }
    unsubscribe = subscribeAgentEvents(sessionId, (event) => {
      if (event.type !== 'run_end') return
      const run = store.getter(runAtom)
      if (isRunBoundary(run)) finish(run)
    })
    const refreshed = store.getter(runAtom)
    if (isRunBoundary(refreshed)) finish(refreshed)
  })
}

async function runPrompt(sessionId: string, prompt: string, reader?: ReadlineBridge): Promise<void> {
  const accepted = await sendMessage(prompt)
  if (!accepted.accepted) throw new Error(`无法启动运行：${accepted.reason}`)
  let run = await waitForRunBoundary(sessionId)
  while (reader && await resumeWaitingRun(run, reader, output)) {
    run = await waitForRunBoundary(sessionId)
  }
  if (!reader) renderWaitingState(run, output)
  // run 失败不许静默：print 模式必须让调用方（人或自动化）看得见并拿到非零退出码。
  if (run.status === 'error') {
    stderr.write(`[error] 运行失败：${run.error ?? '未知错误'}\n`)
    process.exitCode = 1
  }
}

/** Coordinates option parsing, core assembly, and the selected terminal mode. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv, process.cwd())
  if (options.help) {
    output.write(CLI_USAGE)
    return
  }

  const credentials = await resolveModelCredentials({ configPath: options.configPath })
  requireDeepSeekCredential(credentials)
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  // 信号处理是**进程级**的，所以装在进程入口这一层而不是 `assembleCliRuntime` 里：后者在测试里
  // 会被反复调用，把处理器装到真 `process` 上等于让测试进程的信号行为跟着装配走。
  // 它必须先于装配，因为关停钩子要在建命令路由表的那一刻就登记进去。见 `shutdown.ts`。
  const shutdown = installCliShutdown()
  await assembleCliRuntime({
    credentials,
    verbose: options.verbose,
    workspaceRoot,
    registerHostDisposer: shutdown.registerHostDisposer,
  })
  const sessionId = newSession()
  setWorkspaceRoot(workspaceRoot)
  const unsubscribeRenderer = subscribeCliRenderer(sessionId, output)

  try {
    if (options.prompt !== undefined) {
      await runPrompt(sessionId, options.prompt)
      return
    }
    const reader = createInterface({ input: stdin, output: stdout })
    await runRepl({
      output,
      reader,
      runPrompt: (prompt, activeReader) => runPrompt(sessionId, prompt, activeReader),
    })
  } finally {
    unsubscribeRenderer()
  }
}

export function reportCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  stderr.write(`错误：${message}\n`)
}
