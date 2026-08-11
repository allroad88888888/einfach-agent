import { toError } from './internal'
import type { McpConnection } from './types'

/**
 * MCP 连接的**保活探活**：对已服役的连接周期性发一次轻量 ping，连续不通到阈值就判死，
 * 把这条连接交回宿主处理。
 *
 * 为什么要有它：一条长时间没有流量的连接可能早就死了（对端重启、NAT 超时、代理掐断），
 * 而传输层未必给得出 close 事件 —— 不主动探，就要等模型真的去调一个工具才发现，
 * 那时候已经白费了一轮对话。
 *
 * 与 reconnectSchedule.ts 对称：那个只回答「下一次重连等多久、还能不能再试」，
 * 这个只回答「什么时候探、探多久算超时、连续几次不通算死」。两者的定时器都不属于任何
 * 一次 serialize 操作，所以都拆在连接状态机之外。
 *
 * 本文件刻意不认识 ToolRegistry / McpServerRecord / 串行队列：一条连接是不是「此刻正在
 * 服役的那一条」由宿主经 isServing 回答，判死之后怎么办（重连与否、状态与错误怎么写）
 * 也全在宿主 —— 这里【不发起任何重连】。
 */

export interface McpKeepalivePolicy {
  /** 两次探活之间的间隔。 */
  intervalMs: number
  /** 单次探活的超时：超过就算这一次不通。 */
  timeoutMs: number
  /** 连续多少次不通才判死。 */
  failureThreshold: number
}

/**
 * 30 秒探一次、单次 10 秒超时、连续 2 次不通判死。
 *
 * 阈值 2 而不是 1：一次探活超时不等于连接死了 —— 它可能只是这一个请求排在了慢队列后面，
 * 或者赶上一次瞬时拥塞。判死的代价是把服务下线并进入退避重连，不该由单次抖动触发。
 * 代价是发现窗口变长：最坏 2 ×（30 + 10）= 80 秒。对「在下次真实调用前发现」这个目标
 * 足够，而且真实调用本来就会自己撞上传输错误。
 *
 * 30 秒的理由：短于常见的 NAT / 反向代理空闲超时（60 秒起步），所以探活顺带也把连接
 * 焐热了；同时一天下来的请求数（约 2880 次/连接）对任何 MCP 服务都不构成负担。
 */
export const DEFAULT_MCP_KEEPALIVE_POLICY: McpKeepalivePolicy = {
  intervalMs: 30_000,
  timeoutMs: 10_000,
  failureThreshold: 2,
}

/** 宿主要提供的两件事：判断连接是否在役，以及接住判死。 */
export interface McpKeepaliveHost {
  /**
   * 这条连接是不是该服务【此刻正在服役】的那一条。
   *
   * 宿主的判据必须同时包含连接身份与「状态确实是已连接」：只登记从未连过的记录、
   * 正在退避重连的记录、正在换代途中的记录都要回答 false —— 它们没有连接可探，
   * 更不该因为探活而被改动。
   */
  isServing(serverId: string, connection: McpConnection): boolean
  /**
   * 判死。宿主应当把它当作一次「传输层没来得及告诉我们的意外关闭」处理，沿用既有的
   * 串行队列、连接身份世代检查与失败分类，重连交给既有的退避调度。
   *
   * error 是最后一次探活的原始错误，【不作任何包装】：包装成新的 Error 会把对端写的
   * 文本搬进一条我们自己署名的消息里，而失败分类正是靠「消息是谁写的」来决定敢不敢
   * 判永久失败的（见 failureClassification.ts）。原样上交，那套硬化逻辑才继续成立。
   */
  onDead(serverId: string, connection: McpConnection, error: Error): void
}

interface McpKeepaliveState {
  /** 挂起的下一次探活。一次探活进行中时为 undefined —— 没结束就不排下一次，避免堆积。 */
  timer: ReturnType<typeof setTimeout> | undefined
  /** 正在飞的那次探活的取消钩子；没有探活在飞时为 undefined。 */
  cancel: (() => void) | undefined
  /** 连续不通次数；任何一次成功清零。 */
  failures: number
}

function keepaliveTimeoutError(timeoutMs: number): Error {
  // 全文由本包自己写，不含对端一个字：分类器可以放心按消息规则匹配它。
  return new Error(`保活探测超时：连接在 ${timeoutMs} 毫秒内没有回应 ping`)
}

/**
 * 跑一次探活并套上超时。controller 由调用方持有，所以中途 stop() 也能把它掐掉。
 *
 * 超时时【先 reject 再 abort】：反过来的话，abort 会先让底层请求以 AbortError 落地，
 * race 就用那个错误结算了，「是超时」这个信息反而丢掉。Promise.race 对两个 promise
 * 都挂了处理器，所以迟到的那个 rejection 不会变成 unhandled rejection。
 */
async function probeWithTimeout(
  run: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
  controller: AbortController,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(keepaliveTimeoutError(timeoutMs))
      controller.abort()
    }, timeoutMs)
  })

  try {
    await Promise.race([run(controller.signal), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 按 serverId 维护「一张保活表」：一个挂起定时器 + 一次在飞的探活 + 连续失败计数。
 *
 * 约定：起表只发生在一条连接真正进入服役时，停表必须由每条让连接退役的路径显式调用
 * （断开、删除、换代、判死）。定时器不属于任何一次操作，没人替它收尾。
 */
export class McpKeepaliveMonitor {
  private readonly policy: McpKeepalivePolicy
  private readonly states = new Map<string, McpKeepaliveState>()

  constructor(
    private readonly host: McpKeepaliveHost,
    policy: Partial<McpKeepalivePolicy> = {},
  ) {
    this.policy = { ...DEFAULT_MCP_KEEPALIVE_POLICY, ...policy }
  }

  /**
   * 一条连接进入服役：起表。
   *
   * 【不实现 ping 的连接不起表】—— 没有轻量探活手段就不探，绝不退化成拿 listTools 当心跳。
   * 每次起表都换一份新的 state，于是上一世代还在飞的探活落地时能被认出来并丢弃。
   */
  start(serverId: string, connection: McpConnection): void {
    this.stop(serverId)
    if (typeof connection.ping !== 'function') return
    this.arm(serverId, connection, { timer: undefined, cancel: undefined, failures: 0 })
  }

  /**
   * 一条连接退役：停表、掐掉在飞的探活、清空计数。
   * 返回是否真的清掉了一个挂起的定时器。
   */
  stop(serverId: string): boolean {
    const state = this.states.get(serverId)
    if (!state) return false
    this.states.delete(serverId)
    state.cancel?.()
    if (state.timer === undefined) return false
    clearTimeout(state.timer)
    return true
  }

  /** 是否有挂起（尚未触发）的探活。 */
  pending(serverId: string): boolean {
    return this.states.get(serverId)?.timer !== undefined
  }

  /** 当前连续不通次数。 */
  failures(serverId: string): number {
    return this.states.get(serverId)?.failures ?? 0
  }

  get intervalMs(): number {
    return this.policy.intervalMs
  }

  get timeoutMs(): number {
    return this.policy.timeoutMs
  }

  get failureThreshold(): number {
    return this.policy.failureThreshold
  }

  private arm(
    serverId: string,
    connection: McpConnection,
    state: McpKeepaliveState,
  ): void {
    this.states.set(serverId, state)
    state.timer = setTimeout(() => {
      // 定时器落地时表已被换掉 = 这次触发属于上一条连接，丢弃。
      // （clearTimeout 之外的第二道保险，成本一个引用比较。）
      if (this.states.get(serverId) !== state) return
      state.timer = undefined
      void this.probe(serverId, connection, state)
    }, this.policy.intervalMs)
  }

  private async probe(
    serverId: string,
    connection: McpConnection,
    state: McpKeepaliveState,
  ): Promise<void> {
    const ping = connection.ping
    if (!ping || !this.host.isServing(serverId, connection)) {
      this.release(serverId, state)
      return
    }

    const controller = new AbortController()
    state.cancel = () => controller.abort()
    try {
      await probeWithTimeout(
        (signal) => ping.call(connection, { signal }),
        this.policy.timeoutMs,
        controller,
      )
      this.settle(serverId, connection, state, undefined)
    } catch (error) {
      this.settle(serverId, connection, state, toError(error))
    } finally {
      state.cancel = undefined
    }
  }

  /** 一次探活落地：要么排下一次，要么判死，要么整条丢弃。 */
  private settle(
    serverId: string,
    connection: McpConnection,
    state: McpKeepaliveState,
    error: Error | undefined,
  ): void {
    // 探活期间这张表可能已经被停掉或换掉（断开、删除、换代）：那这次成败与现在名下的
    // 连接毫无关系，既不能计数也不能判死。
    if (this.states.get(serverId) !== state) return
    if (!this.host.isServing(serverId, connection)) {
      this.release(serverId, state)
      return
    }

    if (!error) {
      state.failures = 0
      this.arm(serverId, connection, state)
      return
    }

    state.failures += 1
    if (state.failures < this.policy.failureThreshold) {
      this.arm(serverId, connection, state)
      return
    }

    // 判死：先把表撤掉，再上交 —— 宿主接下来会断开这条连接并可能立刻建立新连接，
    // 那条新连接要能干净地起自己的表。
    this.release(serverId, state)
    this.host.onDead(serverId, connection, error)
  }

  private release(serverId: string, state: McpKeepaliveState): void {
    if (this.states.get(serverId) === state) this.states.delete(serverId)
  }
}
