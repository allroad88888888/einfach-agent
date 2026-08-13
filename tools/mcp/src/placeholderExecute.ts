// tools/mcp/src/placeholderExecute.ts —— 占位工具 execute 的【编排】：状态复查 → 单飞连接 →
// 委派给刚注册好的真实工具（蓝图第三节的五步）。
//
// 【为什么不写进 placeholderTool.ts】那边是纯形状：同样的入参得到同样的 Tool，没有 registry、
// 没有 manager、没有任何在途状态。这里全是编排与副作用。
//
// 更硬的一条理由是【单飞表必须比占位实例长寿】：占位由同步器每次重算时新造（登记表与
// registry 的 expected 校验全按实例比对，共享实例会让「谁占着这个名字」失去分辨力）。把在途
// 连接表挂在工具实例上，等于每刷新一次缓存就把它清零；那时两个并发调用会各自 reconnect 一次，
// 而 reconnect 对一条已连上的连接是「先注销全部工具再重建」——第二次会把第一次刚建好的连接
// 拆掉，并打断正在用它的那次调用。所以表挂在本文件造出的执行器上：由同步器创建一次，
// 供它此后造出的所有占位共用。
//
// 【为什么也不写进 placeholderSync.ts】那边回答的是「什么时候该有占位」（生命周期），本文件
// 回答的是「占位被调用时发生什么」（一次调用的编排）。两者唯一的交集是同步器要把执行器交给
// 它造出来的每一个占位。

import type { ToolRegistry } from '@web-agent/core/tools'
import type { ToolContext, ToolResult } from '@web-agent/core/tools'
import type { McpClientManager } from './clientManager'
import { MCP_CONNECT_TIMEOUT_MS } from './connect-mcp-server/connect-mcp-server'
import {
  buildConnectFailureResult,
  buildConnectTimeoutResult,
} from './connect-mcp-server/connectFailureResult'
import { raceWithAbort, throwIfAborted, truncate } from './internal'
import type { McpPlaceholderClaims } from './placeholderClaims'
import {
  annotateDelegatedFailure,
  buildPlaceholderServerGoneResult,
  buildPlaceholderToolGoneResult,
  markViaPlaceholder,
} from './placeholderResult'
import type { McpServerSnapshot } from './types'

/**
 * 执行器要的最小 manager 能力面：查登记表 + 按【已登记 id】重连。
 *
 * ★ 与 McpConnectManager 同一条纪律：故意不包含 connect(config) ★ —— 连接配置全程只存在于
 * manager 内部，占位这条路上模型连「选一个 id」都不做（id 是占位注册时闭包进去的），
 * 更不可能造出一个连接目标。
 */
export type McpPlaceholderConnectManager = Pick<McpClientManager, 'get' | 'reconnect'>

export interface CreateMcpPlaceholderExecutorOptions {
  /** 委派的去处。占位必须闭包住它——理由见下面 delegate 处的注释。 */
  registry: ToolRegistry
  manager: McpPlaceholderConnectManager
  /** 与同步器、manager 的 reconcile 路径【同一个实例】：委派前的存在性检查要问它。 */
  claims: McpPlaceholderClaims
  /** 连接超时；默认 MCP_CONNECT_TIMEOUT_MS（180 秒）。主要为宿主与确定性测试开放。 */
  connectTimeoutMs?: number
}

export interface McpPlaceholderExecutor {
  /** 占位 execute 的全部行为。永远返回 ToolResult，绝不抛——AbortError 除外（控制流）。 */
  execute(
    serverId: string,
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult>
}

/**
 * 一次共享连接的结局。
 *
 * 【为什么不用 reject 表达失败】这个 promise 是单飞的，会被多个调用方同时等待。做成永不
 * reject，就不存在「某一刻它是个没人处理的 rejection」的窗口，每个等待者也不必各自去猜
 * 「这次到底是超时还是失败」——超时那一路本来就不经分类器（见 connectFailureResult.ts）。
 */
type McpConnectOutcome =
  | { status: 'connected'; snapshot: McpServerSnapshot }
  | { status: 'timeout' }
  | { status: 'failed'; error: unknown }

type ConnectStep =
  | { ok: true; snapshot: McpServerSnapshot }
  | { ok: false; result: ToolResult }

export function createMcpPlaceholderExecutor({
  registry,
  manager,
  claims,
  connectTimeoutMs = MCP_CONNECT_TIMEOUT_MS,
}: CreateMcpPlaceholderExecutorOptions): McpPlaceholderExecutor {
  if (!registry || !manager || !claims) {
    throw new Error('createMcpPlaceholderExecutor requires registry, manager and claims')
  }
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new Error('MCP connect timeout must be a positive number')
  }

  /** serverId → 在途的那一次连接。单飞的账本，比任何一个占位实例都长寿（见文件头）。 */
  const inFlight = new Map<string, Promise<McpConnectOutcome>>()

  /**
   * 真正发起一次连接。
   *
   * 连接有自己的 180 秒超时，**不吃**工具调用的 1 小时硬超时（MCP_TOOL_CALL_TIMEOUT_MS）——
   * 否则一个连不上的 stdio 服务能把一次 run 卡住整整一小时。用 raceWithAbort 而不是只把
   * signal 交给 manager：即使 connector 某条路径没有认真响应 abort，超时到点后本次连接也
   * 必须按时给出结局。
   *
   * 【这里刻意不 combine 调用方的 ctx.signal】connect_mcp_server 那样做是对的——那次连接只
   * 属于那一次调用；而这条连接是单飞的、属于所有等待者。让第一个调用方的取消掐断第二个
   * 调用方正在等的连接，等于把单飞刚刚省下的那次「拆连接」又还了回去。调用方各自用
   * raceWithAbort 只中断【自己的等待】（见 execute）。因此一次被取消的调用可能留下一条仍在
   * 建立的连接：那是有意的——连接的生命周期本来就归 manager，起进程的确认也已经在进入
   * execute 之前做过了，连上之后下一次调用直接可用。
   */
  const connectNow = async (serverId: string): Promise<McpConnectOutcome> => {
    const timeoutController = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      timeoutController.abort(new Error(`MCP connect timed out after ${connectTimeoutMs}ms`))
    }, connectTimeoutMs)

    try {
      const snapshot = await raceWithAbort(
        manager.reconnect(serverId, { signal: timeoutController.signal }),
        timeoutController.signal,
      )
      return { status: 'connected', snapshot }
    } catch (error) {
      return timedOut ? { status: 'timeout' } : { status: 'failed', error }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 单飞：同一个 serverId 在途只允许一次连接，第二个调用等到的是同一个 promise。
   *
   * 这是必需项而不是优化（蓝图第三节）：manager.reconnect 会先 abort 掉该服务上一次在途的
   * 连接、再注销它全部工具重建，所以「两个占位调用各连一次」必然让先到的那次连接被拆掉。
   */
  const connectOnce = (serverId: string): Promise<McpConnectOutcome> => {
    const existing = inFlight.get(serverId)
    if (existing) return existing

    const attempt = connectNow(serverId)
    inFlight.set(serverId, attempt)
    void attempt.finally(() => {
      // 只清自己那一条：这次结束时，可能已经有下一轮连接占着位置了。
      if (inFlight.get(serverId) === attempt) inFlight.delete(serverId)
    })
    return attempt
  }

  const connectForCall = async (
    target: McpServerSnapshot,
    ctx: ToolContext,
  ): Promise<ConnectStep> => {
    ctx.progress(`正在连接 MCP 服务「${truncate(target.id, 80)}」`)
    const outcome = await raceWithAbort(connectOnce(target.id), ctx.signal)
    if (outcome.status === 'connected') return { ok: true, snapshot: outcome.snapshot }
    if (outcome.status === 'timeout') {
      return {
        ok: false,
        result: buildConnectTimeoutResult(target.id, target.config.transport, connectTimeoutMs),
      }
    }
    // 共享的那次连接也可能是被【别人】打断的（manager 的下一次 connect/disconnect/remove 会
    // abort 掉在途连接）。本次调用自己没被取消时那就不是控制流，而是一次没连上：按失败回执
    // 处理，retryable 仍由 classifyMcpFailure 决定（见 connectFailureResult.ts）。
    throwIfAborted(ctx.signal)
    return {
      ok: false,
      result: buildConnectFailureResult(target.id, target.config.transport, outcome.error),
    }
  }

  return {
    async execute(serverId, toolName, args, ctx) {
      // 取消是控制流，不能被降级成一条普通的失败回执。每次 await 之后都要再查一次。
      throwIfAborted(ctx.signal)

      // ① 入口校验（args 必须是对象）不在这里重做：registry.run 在调用 execute 之前，已经用
      //    占位那份透传 schema（{ type: 'object' }）校验并规范化过 args。占位的 schema 就是
      //    这道闸，再写一遍只会多一条永远走不到、也就永远测不真的分支。

      // ② 状态复查：登记表是唯一的准入判据。占位是「上次已知」的产物，从它被注册到被调用
      //    之间，服务可能已经被删除，也可能已经由别的路径连上了。
      const target = manager.get(serverId)
      if (!target) {
        return markViaPlaceholder(buildPlaceholderServerGoneResult(serverId, toolName))
      }

      // 已连接就跳过连接直接委派：重连会把该服务的工具全部注销再注册，正在用它的调用会被打断。
      const alreadyConnected = target.status === 'connected'
      let snapshot = target
      if (!alreadyConnected) {
        // ③ 单飞连接。一次调用只尝试一次，退避重连仍然只属于 manager，占位不自己重试。
        const connected = await connectForCall(target, ctx)
        if (!connected.ok) return markViaPlaceholder(connected.result)
        snapshot = connected.snapshot
        throwIfAborted(ctx.signal)
      }

      // ④ reconcile 不在这里做：manager 的连接成功路径内部已经调过 reconcileMcpTools
      //    （与显式连接同一条路），真实工具此刻已经原地覆盖了同名占位。

      // ⑤ 委派（一）· 存在性检查（蓝图第五节）：这个名字现在必须已经是【真实工具】。
      //    判据要两条一起看——registry 里有人，且占位登记表里没人。只看 registry.has 是不够的：
      //    远端改名/下线时这个名字仍被本服务的占位占着，照样委派就是调回自己，成为无限递归。
      if (!registry.has(toolName) || claims.get(toolName) !== undefined) {
        return markViaPlaceholder(
          buildPlaceholderToolGoneResult(toolName, snapshot, alreadyConnected),
        )
      }

      // ⑤ 委派（二）。用 registry.run 而【不是】ctx.callTool：callTool 的防环判据是
      //    [...调用栈, 当前工具名].includes(目标名)，而占位与真实工具共用同一个名字，必然被
      //    判成 tool cycle。这不是可以绕过的实现细节，正是占位必须闭包住 registry 的原因。
      //    参数的第二段校验在这一步、对着【真实工具的 inputSchema】完成（含 default 填充），
      //    所以没有任何一次远端调用是用未经真实 schema 校验的参数发出的。
      //    不传 expectedRegistrationVersion：外层执行器已按占位那一版做过一次原子校验，
      //    这里要执行的正是刚刚注册的新版本。
      //    registry.run 自己就保证「只返回 ToolResult、AbortError 原样抛」，所以这里不包
      //    try/catch —— 包了反而会把取消这条控制流吞掉。
      const result = await registry.run(toolName, args, ctx)
      return annotateDelegatedFailure(result, toolName)
    },
  }
}
