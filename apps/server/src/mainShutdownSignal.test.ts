// 判据：对**真的 server 进程**发真 SIGTERM，然后 `pgrep` 找不到那个 MCP 子进程了
// ---------------------------------------------------------------------------
// 被试的是真正的进程入口 `main.ts`（`--port 0 --no-open`），不是某个可测的中间层：MCP 会话
// 经真的 `/api/invoke/mcp_connect` 建立，信号发给真的进程，断言只看进程表。
//
// ═══ 几个必须这么写的地方 ═══
//
// ① **假 MCP server 用 `stubborn` 模式**（它无视 stdin EOF）。守规矩的 server 在父进程死掉那一刻
//    就会读到 stdin EOF 并自己退出——那样即便关停钩子根本没挂，孙进程也会消失，测试照样绿。
//
// ② **用 `node --import tsx` 起，不能用 `tsx` 那个 CLI**。实测（本卡）：tsx 的 CLI wrapper 会
//    fork 一个子进程并接管信号，被试进程收到 SIGTERM 时 'exit' 回调**照样执行**，于是 host-node
//    的 `exitNet` 兜底把孙进程杀了，测试就证明不了任何事。`--import tsx` 只装模块 loader，信号
//    处置与 plain node 一致——也就是与 `apps/server/dist/main.js`（tsup 打包后由 plain node 跑的
//    分发形态）一致。顺带一提：`pnpm serve` 走的正是 tsx CLI，**开发机上碰不到这个缺陷**。
//
// ③ **marker 只经环境变量进被试进程**（`pgrep -f` 匹配命令行；marker 出现在被试进程自己的 argv
//    里就分不清"孙进程还在"和"我自己还在"了）。这里 marker 是随 `mcp_connect` 的 args 走 HTTP
//    过去的，天然不在被试进程的命令行里。
//
// 【为什么这里没有负对照】"没有信号处理器时孙进程会活下来"这条已经由
// `apps/cli/src/shutdownSignal.test.ts` 的负对照钉住（那是同一个 Node 语义、同一个 host-node
// 兜底）。要在 server 侧再来一条，就得给生产代码开一个"别装信号处理"的开关，那是为测试而生的
// 生产开关，不划算。
//
// 清理：`try/finally` 强杀 + `afterEach` 兜底。本卡的主题就是别让子进程活过它的宿主。

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
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
const SERVER_ENTRY = join(ROOT, 'apps/server/src/main.ts')
const FAKE_MCP_SERVER = join(ROOT, 'packages/host-node/src/mcp/fakeMcpServer.cjs')

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

/** 用 `node:http` 而不是 fetch：jsdom 环境下的全局 fetch 是不是 Node 的那一个不该由这条测试来赌。 */
function postInvoke(
  origin: string,
  token: string,
  command: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(args)
    const call = request(
      `${origin}/api/invoke/${command}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    call.on('error', reject)
    call.end(payload)
  })
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) expect.fail(`超时未满足：${message}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

interface RunningServer {
  readonly child: ChildProcess
  origin: string
  token: string
  /** 进程退出的时刻，用来判它到底等没等 MCP 会话的 grace。见用例里的说明。 */
  exitedAt: number | undefined
}

async function startServer(): Promise<RunningServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY, '--port', '0', '--no-open'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TSX_TSCONFIG_PATH: join(ROOT, 'apps/server/tsconfig.json') },
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const started: RunningServer = { child, origin: '', token: '', exitedAt: undefined }
  child.once('exit', () => { started.exitedAt = Date.now() })

  const deadline = Date.now() + 30_000
  for (;;) {
    const printed = /(http:\/\/127\.0\.0\.1:(\d+))\/\?token=([A-Za-z0-9_-]+)/.exec(stdout)
    if (printed) {
      started.origin = printed[1] as string
      started.token = printed[3] as string
      return started
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      expect.fail(`server 30 秒内没有打印启动信息。stdout=${stdout} stderr=${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const markers: string[] = []
const running: ChildProcess[] = []

afterEach(() => {
  while (running.length > 0) running.pop()?.kill('SIGKILL')
  while (markers.length > 0) killMarked(markers.pop() as string)
})

describe.skipIf(process.platform === 'win32')('server 宿主收到 SIGTERM 时回收 MCP 子进程', () => {
  it('经 /api/invoke 连上的 MCP 子进程，在 SIGTERM 之后 pgrep 找不到了', async () => {
    const server = await startServer()
    running.push(server.child)
    const marker = `c5-server-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    markers.push(marker)

    try {
      const connected = await postInvoke(server.origin, server.token, 'mcp_connect', {
        input: {
          serverId: 'c5-server-probe',
          sessionToken: 'c5-server-probe-session',
          command: process.execPath,
          args: [FAKE_MCP_SERVER, 'stubborn', '1', marker],
          requestTimeoutMs: 5_000,
        },
      })
      expect(connected.status, connected.body).toBe(200)
      const pid = (JSON.parse(connected.body) as { pid: number }).pid

      expect(pgrepMarker(marker)).toEqual([pid])

      const signalledAt = Date.now()
      server.child.kill('SIGTERM')

      await waitUntil(
        () => pgrepMarker(marker).length === 0,
        `SIGTERM 之后孙进程（pid ${pid}）仍在进程表里`,
        10_000,
      )
      await waitUntil(() => server.exitedAt !== undefined, 'server 进程没有退出', 5_000)
      // 128 + SIGTERM(15)：走的是我们自己的 `process.exit`，而不是被信号默认处置终结——
      // 后者不会执行 'exit' 回调，也就没有 host-node 的兜底。
      expect(server.child.exitCode).toBe(143)

      // 【为什么还要判这个耗时】只判"孙进程没了"**不足以证明关停钩子接上了**：我们自己调
      // `process.exit` 这一步会触发 host-node 的 'exit' 兜底，它同步整组 SIGKILL，即使
      // `registerHostDisposer` 根本没传下去，孙进程照样会消失（本卡实测：把 `mainRunServer.ts`
      // 里那个参数删掉，只判 pgrep 的用例仍然是绿的）。
      // 能把两条路分开的是**耗时**：走关停钩子时，`disposeAll()` 要关 stdin 再等一个完整的
      // grace（host-node 的 `DEFAULT_DISCONNECT_GRACE_MS` = 500 ms，而这个假 server 是
      // `stubborn`、绝不会提前退），所以进程退出**必然**晚于信号 500 ms；走兜底时它几乎是
      // 立刻退。300 ms 的门槛取在两者中间，且只可能被"grace 被改小"这一件事推翻。
      expect(server.exitedAt as number).toBeGreaterThanOrEqual(signalledAt + 300)
    } finally {
      server.child.kill('SIGKILL')
      killMarked(marker)
    }
  }, 60_000)
})
