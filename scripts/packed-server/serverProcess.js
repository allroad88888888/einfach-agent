// 起停那个装出来的可执行入口，并确认它停干净了
// ---------------------------------------------------------------------------
// 这个文件只负责**进程**：spawn、从启动横幅里读出真实地址与 token、停、复查没有残留。
// 验什么在 check-packed-server.js，产物怎么来的在 consumerInstall.js。
//
// 【为什么隔离 HOME】
// 库文件路径由 `resolveSqliteDatabasePath` 从主目录算出来（macOS 是
// `~/Library/Application Support/com.webagent.app/web-agent.db`）。不隔离的话，这条门禁会往
// **跑门禁那个人的真实会话库**里建表写数据。隔离之后还白得一条好处：判据④可以直接去那个
// 临时主目录底下找库文件，找到即证明「写到了盘上」。
// `XDG_DATA_HOME` / `APPDATA` 一并删掉——它们会把库文件领到 HOME 以外去，那样上面这条就不成立了。
//
// 【为什么 `--port 0`】
// 系统分配空闲端口，真实端口从启动横幅里读、不猜。写死端口的门禁在并发跑的 CI 上会互相踩。
//
// 【token 从哪来】
// 启动横幅里的 `http://127.0.0.1:PORT/?token=<token>` 是 token 唯一允许出现的出口
// （`apps/server/src/authToken.ts` 的链路②）。这里照原样解析，不另开后门。

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdir } from 'node:fs/promises'

/** 启动横幅里那一行完整 URL。token 是 base64url，字符集与这条正则一致。 */
const STARTUP_URL = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/

const STARTUP_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 15_000

function wait(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds) })
}

/** 子进程环境：隔离主目录，并抹掉会把库文件领出 HOME 的两个变量。 */
function childEnvironment(homeDirectory) {
  const env = { ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory }
  delete env.XDG_DATA_HOME
  delete env.APPDATA
  return env
}

/**
 * 起服务，等它打印出地址。
 *
 * 返回的 `log()` 给失败路径用：任何一条判据红了都要能贴出服务端当时说了什么，
 * 否则报告里只剩「第 4 条失败」这种指不出病因的话。
 */
export async function startPackedServer({ binary, consumerDirectory, homeDirectory }) {
  await mkdir(homeDirectory, { recursive: true })
  const child = spawn(binary, ['--port', '0', '--no-open'], {
    cwd: consumerDirectory,
    env: childEnvironment(homeDirectory),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  let exited
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => { exited = { code, signal }; resolve(exited) })
  })

  const handle = {
    child,
    homeDirectory,
    exit,
    log: () => output,
    get exited() { return exited },
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const match = STARTUP_URL.exec(output)
    if (match) {
      handle.port = Number(match[1])
      handle.origin = `http://127.0.0.1:${match[1]}`
      handle.token = match[2]
      return handle
    }
    if (exited) {
      throw new Error(
        `打包产物起不来：进程已退出（code=${exited.code} signal=${exited.signal}）。\n` +
          `服务端输出原文：\n${output || '（空）'}`,
      )
    }
    await wait(100)
  }
  child.kill('SIGKILL')
  throw new Error(`等了 ${STARTUP_TIMEOUT_MS / 1000}s 没等到启动横幅。服务端输出原文：\n${output || '（空）'}`)
}

/** 端口上还有没有人在听。用来复查「停干净了」，不依赖 HTTP 层。 */
function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(2000)
    socket.on('connect', () => { settle(true) })
    socket.on('error', () => { settle(false) })
    socket.on('timeout', () => { settle(false) })
  })
}

/** 进程还在不在。`kill(pid, 0)` 不发信号，只做存在性判定。 */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

/**
 * 判据⑤：停服务后无残留进程。
 *
 * 三件事一起判，缺一条都可能「看起来停了」：进程真的退出（等到 exit 事件）、pid 真的不在了
 * （`kill(pid, 0)` 报 ESRCH）、端口不再接受连接。只 `kill()` 不复查的话，一个忽略 SIGTERM
 * 的进程会一直挂在那儿而门禁照样绿。
 */
export async function stopPackedServer(handle) {
  const { child } = handle
  const pid = child.pid
  if (!handle.exited) child.kill('SIGTERM')

  const timeout = wait(SHUTDOWN_TIMEOUT_MS).then(() => 'timeout')
  const finished = await Promise.race([handle.exit, timeout])
  if (finished === 'timeout') {
    child.kill('SIGKILL')
    throw new Error(
      `判据⑤失败：SIGTERM 之后 ${SHUTDOWN_TIMEOUT_MS / 1000}s 内进程（pid=${pid}）没有退出，已 SIGKILL。\n` +
        `服务端输出原文：\n${handle.log()}`,
    )
  }

  // 退出事件到达与内核回收之间有窗口，短轮询一下再判，避免把时序当成残留。
  for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) await wait(100)
  if (processAlive(pid)) {
    throw new Error(`判据⑤失败：进程退出后 pid=${pid} 仍然存在（残留进程）。`)
  }
  if (await portAccepts(handle.port)) {
    throw new Error(`判据⑤失败：进程已退出，但 127.0.0.1:${handle.port} 仍在接受连接（残留监听）。`)
  }
}
