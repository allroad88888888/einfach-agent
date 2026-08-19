// 建一条会话：起进程 + 把三条管道接上
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_session_spawn.rs 的装配段。Rust 那边接的是三条线程
// （stderr / stdout / 进程监视），Node 这边接的是三组事件回调：
//   stdout —— readProtocolStream，帧切分 + 分发 + EOF 报关闭
//   stderr —— drainStderr，只为了不让管道写满把子进程堵死
//   child  —— 'exit'，由 McpSession 自己在构造时挂上（那是它的状态）
//
// Rust 那边每一步失败都要手工回滚（关 stdin、杀进程、join 已起的线程），四段几乎一样的
// 清理代码；Node 这边挂 listener 不会失败，所以回滚只剩「spawn 之后到 return 之前若抛错，
// 把进程杀掉」这一处兜底——不是简化了逻辑，是那些失败模式本身不存在。

import { drainStderr, spawnMcpChild, terminateSpawnedChild } from './childProcess'
import { trackChildForHostExit } from './exitNet'
import type { McpConnectInput } from './inputs'
import { McpLifecycleNotifier, type McpHostEventEmitter } from './lifecycle'
import { readProtocolStream } from './reader'
import { McpSession } from './session'
import { McpStdinWriter } from './writer'

export async function spawnMcpSession(
  input: McpConnectInput,
  serverId: string,
  sessionToken: string,
  defaultTimeoutMs: number,
  emitHostEvent: McpHostEventEmitter,
): Promise<McpSession> {
  const spawned = await spawnMcpChild(input)
  try {
    const writer = new McpStdinWriter(spawned.stdin)

    // 通知器要问会话「是不是在主动关闭」，而会话构造时要拿到通知器——一个环。用一个可变引用
    // 打开它：`session` 赋值之前 `isClosing()` 恒为 false，而那一刻本来就没有任何东西在关闭。
    let session: McpSession | undefined
    const lifecycle = new McpLifecycleNotifier(
      serverId,
      sessionToken,
      emitHostEvent,
      () => session?.isClosing() ?? false,
    )

    const untrackFromHostExit = trackChildForHostExit(spawned.child)
    session = new McpSession({
      serverId,
      sessionToken,
      pid: spawned.pid,
      defaultTimeoutMs,
      child: spawned.child,
      writer,
      lifecycle,
      untrackFromHostExit,
    })

    drainStderr(spawned.stderr)
    readProtocolStream(spawned.stdout, {
      writer,
      pending: session.pending,
      lifecycle,
      // stdout EOF **不关 stdin**：进程可能还活着，只是关掉了自己的 stdout。
      onTransportClosed: (message) => session?.closeTransport(message),
    })

    return session
  } catch (error) {
    // 到这里只可能是宿主自己的 bug（listener 挂不上）。进程已经起来了，不杀就是本卡最要防的
    // 那种泄漏——一个没人再引用、也没人再杀的 MCP server。
    await terminateSpawnedChild(spawned.child)
    throw error
  }
}
