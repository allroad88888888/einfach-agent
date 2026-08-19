// 「真的发信号」那条判据的被试进程：CLI 宿主 + 一个赖着不走的 MCP 子进程
// ---------------------------------------------------------------------------
// 由 `shutdownSignal.test.ts` 用 tsx 起成子进程（tsconfig 走 `apps/cli/tsconfig.json`，与
// `pnpm cli` 同一套 paths 映射，确保 `@einfach-agent/host-node` 解析到 **src** 而不是可能过期的 dist）。
// 这里刻意**不**引 vitest 的任何东西：它跑在一个普通的 Node 进程里，不是测试环境。
//
// 拿到的进程谱系是：vitest（祖父）→ 本进程（父）→ 假 MCP server（孙）。测试对着本进程发真信号，
// 再用 pgrep 找孙进程。孙进程用 `stubborn` 模式，它**无视 stdin EOF**——这一点是判据成立的关键：
// 守规矩的 server 在父进程死掉、管道写端关闭时会自己退出，那样即使关停钩子没挂上也看不出问题。
//
// 环境变量（**刻意不用 argv**：`pgrep -f` 匹配的是命令行，marker 一旦出现在本进程的 argv 里，
// 它就会和孙进程一起被匹配到，测试就分不清"孙进程还在"和"我自己还在"）：
//   · C5_FAKE_SERVER   —— fakeMcpServer.cjs 的绝对路径
//   · C5_MARKER        —— 只出现在孙进程 argv 里的唯一标记
//   · C5_SKIP_SHUTDOWN —— '1' 时**不装**信号处理，用作负对照

import { createNodeHostInvoke } from '@einfach-agent/host-node'
import { installCliShutdown } from './shutdown'

const marker = process.env.C5_MARKER ?? 'c5-missing-marker'
const fakeServer = process.env.C5_FAKE_SERVER ?? ''
const skipShutdown = process.env.C5_SKIP_SHUTDOWN === '1'

const shutdown = skipShutdown ? undefined : installCliShutdown()
const invoke = createNodeHostInvoke(
  shutdown === undefined ? {} : { registerHostDisposer: shutdown.registerHostDisposer },
)

const connected = await invoke<{ pid: number }>('mcp_connect', {
  input: {
    serverId: 'c5-probe',
    sessionToken: 'c5-probe-session',
    command: process.execPath,
    args: [fakeServer, 'stubborn', '1', marker],
    requestTimeoutMs: 5_000,
  },
})

process.stdout.write(`READY ${connected.pid}\n`)

// MCP 子进程与它的三条管道都被 host-node `unref` 过（否则 CLI 跑完一轮永远退不掉），
// 所以这里必须自己钉住 event loop，不然本进程会在连接建立后立刻正常退出——那条路会触发
// host-node 的 'exit' 兜底，孙进程照样死掉，于是判据变成永远为真的废话。
setInterval(() => {}, 1_000)
