// 判据：**真的发信号**，然后 `pgrep` 找不到那个 MCP 子进程了
// ---------------------------------------------------------------------------
// 这条测试不看"dispose 被调用过"（那是 `shutdown.test.ts` 的事），只看**进程表**：
// 起一个真的 CLI 宿主进程 → 它连上一个真的假 MCP server（孙进程，`stubborn` 模式，无视 stdin
// EOF）→ 对宿主发真 SIGTERM → 轮询 `pgrep -f <marker>` 直到孙进程消失。
//
// ═══ 三个必须这么写的地方，写错了这条测试就变成永远为真的废话 ═══
//
// ① **孙进程必须是 `stubborn` 模式**。守规矩的 MCP server 在父进程死掉的那一刻就会读到
//    stdin EOF（管道写端随进程一起关闭）并自己退出——那样即便关停钩子根本没挂，孙进程也会
//    消失，测试照样绿。`stubborn` 无视 EOF 且自带 `setInterval`，只有真的被杀才会没。
//
// ② **被试进程必须用 `node --import tsx` 起，不能用 `tsx` 那个 CLI**。实测（本卡）：tsx 的 CLI
//    wrapper 会 fork 一个子进程并接管信号，被试进程收到 SIGTERM 时**'exit' 回调照样执行**，
//    于是 host-node 的 `exitNet` 兜底把孙进程杀了——负对照当场失效，测试变成证明不了任何事。
//    `--import tsx` 只装模块 loader，进程的信号处置与 `node` 完全一致（同一组探针实测：
//    'exit' 回调不执行、孙进程活下来）。**这也意味着 `pnpm serve` / `pnpm cli` 那两条 tsx 命令
//    在开发机上碰不到这个缺陷，而打包后的 `apps/server/dist/main.js`（plain node）碰得到。**
//
// ③ **marker 只能经环境变量传给被试进程**。`pgrep -f` 匹配的是命令行；marker 一旦出现在被试
//    进程自己的 argv 里，`pgrep -f` 就会同时匹配到它，"孙进程还在不在"这个问题就问不出来了。
//
// 清理：每个用例自己 `try/finally` 强杀，`afterEach` 再兜一次。负对照那条**故意留下一个活着的
// 孙进程**，它必须在同一个用例里被杀干净——这条测试的主题就是"别让子进程活过它的宿主"。

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/** 从 cwd 往上找 pnpm-workspace.yaml 定位仓库根（jsdom 下 `import.meta.url` 不是 file:，用不了）。 */
function repositoryRoot(): string {
  let current = process.cwd()
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current)
    expect(parent, '从 cwd 往上找不到 pnpm-workspace.yaml').not.toBe(current)
    current = parent
  }
  return current
}

const ROOT = repositoryRoot()
const HARNESS = join(ROOT, 'apps/cli/src/shutdownSignal.testHarness.ts')
const FAKE_MCP_SERVER = join(ROOT, 'packages/host-node/src/mcp/fakeMcpServer.cjs')

/** 命令行里带 marker 的进程。找不到时 `pgrep` 退出码是 1，不是错误。 */
function pgrepMarker(marker: string): number[] {
  const found = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' })
  if (found.status !== 0) return []
  return found.stdout.split('\n').map((line) => Number(line.trim())).filter((pid) => pid > 0)
}

function killMarked(marker: string): void {
  for (const pid of pgrepMarker(marker)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经没了。
    }
  }
}

interface Subject {
  readonly child: ChildProcess
  readonly marker: string
  grandchildPid: number
  /** 进程退出的时刻，用来判它到底等没等 MCP 会话的 grace。见用例里的说明。 */
  exitedAt: number | undefined
}

async function startSubject(options: { skipShutdown?: boolean } = {}): Promise<Subject> {
  const marker = `c5-shutdown-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const child = spawn(process.execPath, ['--import', 'tsx', HARNESS], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: join(ROOT, 'apps/cli/tsconfig.json'),
      C5_MARKER: marker,
      C5_FAKE_SERVER: FAKE_MCP_SERVER,
      ...(options.skipShutdown === true ? { C5_SKIP_SHUTDOWN: '1' } : {}),
    },
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const started: Subject = { child, marker, grandchildPid: 0, exitedAt: undefined }
  child.once('exit', () => { started.exitedAt = Date.now() })

  const deadline = Date.now() + 30_000
  for (;;) {
    const ready = /READY (\d+)/.exec(stdout)
    if (ready) {
      started.grandchildPid = Number(ready[1])
      return started
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      killMarked(marker)
      expect.fail(`被试进程 30 秒内没有报 READY。stdout=${stdout} stderr=${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) expect.fail(`超时未满足：${message}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const markers: string[] = []

afterEach(() => {
  // 兜底：用例自己已经清过一遍，这里是"断言中途失败"时的最后一道网。
  while (markers.length > 0) killMarked(markers.pop() as string)
})

describe.skipIf(process.platform === 'win32')('CLI 宿主收到 SIGTERM 时回收 MCP 子进程', () => {
  it('SIGTERM 之后 pgrep 找不到那个假 MCP server 了', async () => {
    const subject = await startSubject()
    markers.push(subject.marker)
    try {
      // 起点：孙进程确实在，而且就是宿主报回来的那个 pid。
      expect(pgrepMarker(subject.marker)).toEqual([subject.grandchildPid])

      const signalledAt = Date.now()
      subject.child.kill('SIGTERM')

      await waitUntil(
        () => pgrepMarker(subject.marker).length === 0,
        `SIGTERM 之后孙进程（pid ${subject.grandchildPid}）仍在进程表里`,
        10_000,
      )
      await waitUntil(() => subject.exitedAt !== undefined, '宿主进程没有退出', 5_000)
      // 128 + SIGTERM(15)：走的是我们自己的 `process.exit`，不是被信号默认处置终结。
      expect(subject.child.exitCode).toBe(143)

      // 【为什么还要判这个耗时】只判"孙进程没了"**不足以证明关停钩子接上了**：我们自己调
      // `process.exit` 这一步会触发 host-node 的 'exit' 兜底，它同步整组 SIGKILL，即使
      // `registerHostDisposer` 根本没传下去，孙进程照样会消失（本卡实测过这个变异）。
      // 能把两条路分开的是**耗时**：走关停钩子时 `disposeAll()` 要关 stdin 再等一个完整的
      // grace（host-node 的 `DEFAULT_DISCONNECT_GRACE_MS` = 500 ms，而这个假 server 是
      // `stubborn`、绝不会提前退），所以退出必然晚于信号 500 ms；走兜底时几乎是立刻退。
      expect(subject.exitedAt as number).toBeGreaterThanOrEqual(signalledAt + 300)
    } finally {
      subject.child.kill('SIGKILL')
      killMarked(subject.marker)
    }
  }, 60_000)

  it('负对照：不挂关停钩子时，同一个 SIGTERM 会把孙进程留在机器上', async () => {
    const subject = await startSubject({ skipShutdown: true })
    markers.push(subject.marker)
    try {
      expect(pgrepMarker(subject.marker)).toEqual([subject.grandchildPid])

      subject.child.kill('SIGTERM')
      await waitUntil(() => subject.child.exitCode !== null || subject.child.signalCode !== null, '宿主进程没有退出', 5_000)

      // 宿主已经死了，孙进程还活着——这正是本卡要消灭的形态，也证明上一条用例的绿不是白捡的：
      // 没有信号处理器时 Node 走默认处置，'exit' 回调不执行，host-node 的兜底根本没机会跑。
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(pgrepMarker(subject.marker)).toEqual([subject.grandchildPid])
    } finally {
      // 这条用例**故意**制造了一个孤儿进程，必须由它自己收拾干净。
      subject.child.kill('SIGKILL')
      killMarked(subject.marker)
      await waitUntil(() => pgrepMarker(subject.marker).length === 0, '负对照留下的孙进程没清干净', 5_000)
    }
  }, 60_000)
})
