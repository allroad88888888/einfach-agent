// 会话登记表：谁连着、谁在连、谁在关，以及四条命令的编排
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_manager.rs（已随 T1 删除）的 `McpManager`。
//
// ═══ 三个集合 + 一个 tombstone，各挡一类竞态 ═══
//   sessions          —— 连上了的。
//   connecting        —— 正在连（已经占了名额，但还没有 session 对象）。
//   closing           —— 正在关（session 已经摘出登记表，进程还没收尸）。
//   usedSessionTokens —— **用过的令牌永不复用**。这是整套设计的支点：前端每次连接生成一个新
//                        令牌，之后的每一条命令（列举、调用、注销）和每一个生命周期事件都带着
//                        它。旧进程迟到的关闭通知、取消后的清理请求，会因为令牌对不上而被拒，
//                        伤不到随后建立的新会话。
// 前三个合起来保证「一个 serverId 在任一时刻只有一条在途的生命周期操作」——少了 connecting 或
// closing，一次快速的「注销→重连」就能让两个子进程同时活着，而登记表里只记得住一个，另一个
// 从此没人能杀。
//
// ═══ 关于「锁」═══
// Rust 用 `Mutex<McpRegistry>` 把「查表 + 占位」做成原子的。Node 是单线程事件循环，**只要
// 检查和占位之间没有 await，中途就插不进任何东西**——所以下面 `reserve()` 是纯同步的，这不是
// 省事，是等价物。真正要小心的是别在那段中间加 await（比如"顺手先探测一下命令在不在"）。

import { McpCommandError, withServerId } from './errors'
import { initializeSession } from './initialize'
import type {
  McpCallToolInput,
  McpConnectInput,
  McpDisconnectInput,
  McpListToolsInput,
} from './inputs'
import {
  DEFAULT_DISCONNECT_GRACE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_DISCONNECT_GRACE_MS,
  MAX_SESSION_TOKENS,
} from './limits'
import type { McpHostEventEmitter } from './lifecycle'
import type { McpConnectResult, McpDisconnectResult, McpListToolsResult } from './results'
import type { McpSession } from './session'
import { spawnMcpSession } from './sessionSpawn'
import { callTool, listTools } from './toolOperations'
import {
  normalizeClientInfo,
  normalizeIdentifier,
  normalizeProtocolVersion,
  normalizeTimeout,
  validateCommand,
} from './validation'

export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>()
  private readonly connecting = new Set<string>()
  private readonly closing = new Set<string>()
  private readonly usedSessionTokens = new Set<string>()

  constructor(private readonly emitHostEvent: McpHostEventEmitter) {}

  async connect(input: McpConnectInput): Promise<McpConnectResult> {
    const serverId = normalizeIdentifier(input.serverId, 'serverId')
    const sessionToken = withServerId(serverId, () =>
      normalizeIdentifier(input.sessionToken, 'sessionToken'))
    // 校验全部排在 spawn 之前：一份坏配置不该先把进程拉起来再发现。
    validateCommand(input.command, serverId)
    const defaultTimeoutMs = normalizeTimeout(
      input.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
      serverId,
    )
    const protocolVersion = withServerId(serverId, () =>
      normalizeProtocolVersion(input.protocolVersion))
    const clientInfo = normalizeClientInfo(input.clientInfo, serverId)

    this.reserve(serverId, sessionToken)
    try {
      const session = await spawnMcpSession(
        input,
        serverId,
        sessionToken,
        defaultTimeoutMs,
        this.emitHostEvent,
      )
      let result: McpConnectResult
      try {
        result = await initializeSession(session, protocolVersion, clientInfo)
      } catch (error) {
        // 握手失败 = 这个进程不能用。**必须在这里就把它关掉**：它从未进过 sessions 表，
        // 之后没有任何一条命令能再指到它，不关就是一个谁也够不着的孤儿进程。
        await session.close(DEFAULT_DISCONNECT_GRACE_MS)
        throw error
      }
      this.sessions.set(serverId, session)
      return result
    } finally {
      this.connecting.delete(serverId)
    }
  }

  async listTools(input: McpListToolsInput): Promise<McpListToolsResult> {
    const serverId = normalizeIdentifier(input.serverId, 'serverId')
    const sessionToken = withServerId(serverId, () =>
      normalizeIdentifier(input.sessionToken, 'sessionToken'))
    return listTools(this.session(serverId, sessionToken), input)
  }

  async callTool(input: McpCallToolInput): Promise<Record<string, unknown>> {
    const serverId = normalizeIdentifier(input.serverId, 'serverId')
    const sessionToken = withServerId(serverId, () =>
      normalizeIdentifier(input.sessionToken, 'sessionToken'))
    const toolName = withServerId(serverId, () => normalizeIdentifier(input.name, 'name'))
    return callTool(this.session(serverId, sessionToken), input, toolName)
  }

  async disconnect(input: McpDisconnectInput): Promise<McpDisconnectResult> {
    const serverId = normalizeIdentifier(input.serverId, 'serverId')
    const sessionToken = withServerId(serverId, () =>
      normalizeIdentifier(input.sessionToken, 'sessionToken'))
    const graceMs = Math.min(
      input.gracePeriodMs ?? DEFAULT_DISCONNECT_GRACE_MS,
      MAX_DISCONNECT_GRACE_MS,
    )

    const session = this.takeForClosing(serverId, sessionToken)
    try {
      const outcome = await session.close(graceMs)
      return {
        serverId,
        sessionToken,
        // `exitCode` 为 null（被信号杀死）时**整个键不出现**，对齐 Rust 的
        // `skip_serializing_if = "Option::is_none"`。
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
        forcedKill: outcome.forcedKill,
      }
    } finally {
      this.closing.delete(serverId)
    }
  }

  /**
   * 关掉全部会话。对应 Rust 的 `impl Drop for McpManagerInner`（应用退出时 Tauri 释放 managed
   * state 会走到那里）。Node 没有析构，所以这条路要由宿主装配层在关停时显式调用——
   * `createMcpRoutes({ registerHostDisposer })` 就是为了把它交出去。
   *
   * 并发关而不是逐个关：每条会话最坏要等一个完整的 grace，串行的话 10 个服务就是 5 秒。
   */
  async disposeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.connecting.clear()
    this.closing.clear()
    this.usedSessionTokens.clear()
    await Promise.all(sessions.map((session) => session.close(DEFAULT_DISCONNECT_GRACE_MS)))
  }

  /** 占位。**纯同步**——见文件头「关于锁」。 */
  private reserve(serverId: string, sessionToken: string): void {
    if (
      this.sessions.has(serverId)
      || this.connecting.has(serverId)
      || this.closing.has(serverId)
    ) {
      throw new McpCommandError(
        'already_connected',
        `MCP server \`${serverId}\` is already connected, connecting, or disconnecting`,
      ).forServer(serverId)
    }
    if (this.usedSessionTokens.has(sessionToken)) {
      throw new McpCommandError(
        'stale_session',
        'MCP sessionToken has already been used; reconnect with a fresh token',
      ).forServer(serverId)
    }
    if (this.usedSessionTokens.size >= MAX_SESSION_TOKENS) {
      throw new McpCommandError(
        'session_limit',
        `MCP session token safety limit (${MAX_SESSION_TOKENS}) reached; restart the application`,
      ).forServer(serverId)
    }
    // 令牌**在这里就烧掉**，连接成不成功都不还——失败的那次连接可能已经把进程拉起来过了，
    // 让同一个令牌再来一次就没法区分「这是第几代进程」。
    this.usedSessionTokens.add(sessionToken)
    this.connecting.add(serverId)
  }

  /** 摘出会话准备关闭。摘除与置 closing 之间没有 await，所以中途插不进第二次 disconnect。 */
  private takeForClosing(serverId: string, sessionToken: string): McpSession {
    const session = this.sessions.get(serverId)
    if (session === undefined) {
      // 三种「没连着」分开措辞：用户看到「正在连接中」和「未连接」时该做的事不一样。
      const message = this.connecting.has(serverId)
        ? `MCP server \`${serverId}\` is still connecting`
        : this.closing.has(serverId)
          ? `MCP server \`${serverId}\` is disconnecting`
          : `MCP server \`${serverId}\` is not connected`
      throw new McpCommandError('not_connected', message).forServer(serverId)
    }
    this.assertCurrentGeneration(session, serverId, sessionToken)
    this.sessions.delete(serverId)
    this.closing.add(serverId)
    return session
  }

  private session(serverId: string, sessionToken: string): McpSession {
    const session = this.sessions.get(serverId)
    if (session === undefined) {
      throw new McpCommandError(
        'not_connected',
        `MCP server \`${serverId}\` is not connected`,
      ).forServer(serverId)
    }
    this.assertCurrentGeneration(session, serverId, sessionToken)
    return session
  }

  /**
   * 世代检查。挡的是「上一代连接的迟到清理打到这一代身上」——注销一个服务再立刻重连，
   * 旧连接排队中的 disconnect 若不带世代判据，会把刚建立的新进程杀掉，而 UI 上显示已连接。
   */
  private assertCurrentGeneration(
    session: McpSession,
    serverId: string,
    sessionToken: string,
  ): void {
    if (session.sessionToken !== sessionToken) {
      throw new McpCommandError(
        'stale_session',
        `MCP server \`${serverId}\` belongs to a newer session`,
      ).forServer(serverId)
    }
  }
}
