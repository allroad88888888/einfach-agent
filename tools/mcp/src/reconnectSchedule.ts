import { truncate } from './internal'

/**
 * MCP 断线后自动重连的**退避调度**：只回答「下一次重试等多久、还能不能再试」。
 *
 * 刻意不认识 McpConnection / ToolRegistry / McpServerRecord —— 世代安全属于
 * clientManager.ts 那台状态机，这里只持有「每个 serverId 一个挂起定时器 + 一个
 * 已用次数」。拆出来是因为定时器的生命周期不属于任何一次 serialize 操作，
 * 混在连接管理里会把两种时间线搅在一起。
 */

export interface McpReconnectPolicy {
  /** 第一次重试前等待的毫秒数。 */
  initialDelayMs: number
  /** 退避上限：翻倍到此为止，之后每次都等这么久。 */
  maxDelayMs: number
  /**
   * 一条重连链最多尝试几次；耗尽后调用方必须把服务落成永久失败。
   *
   * 这个上限是**必需项**而不是调参：failureClassification.ts 之所以敢把
   * 「看起来像认证失败但没有 401/403 佐证」的错误判成暂时失败，前提就是重试有预算 ——
   * 没有上限，一个 API key 写错的服务会被无限重试下去。
   */
  maxAttempts: number
}

/**
 * 1s → 2s → 4s → 8s → 16s → 30s，共 6 次、约 61 秒后停手。
 *
 * 6 次的理由：覆盖一次进程重启 / 网络抖动（典型 5~30 秒）绰绰有余，同时把
 * 「其实是永久失败但被判成暂时」的代价夹在一分钟内 —— 之后用户会看到一个带原因的
 * 永久失败，而不是一个永远转圈、永远不告诉他为什么的服务。手动重连会重置预算。
 *
 * 不加抖动（jitter）：服务数量是用户手配的个位数，不存在惊群；而确定的退避序列
 * 让「现在到底在等第几次」在 UI 与测试里都可预期。
 */
export const DEFAULT_MCP_RECONNECT_POLICY: McpReconnectPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 6,
}

/** 第 attemptIndex 次重试（0 起）之前应等待的毫秒数。 */
export function mcpReconnectDelayMs(
  attemptIndex: number,
  policy: McpReconnectPolicy = DEFAULT_MCP_RECONNECT_POLICY,
): number {
  // 先把指数夹住再乘：attemptIndex 很大时 2 ** n 会溢出成 Infinity，
  // Infinity * 0 会得到 NaN，而 NaN 传进 setTimeout 会被当成 0 立刻触发。
  const exponent = Math.min(Math.max(0, Math.trunc(attemptIndex)), 32)
  const raw = policy.initialDelayMs * 2 ** exponent
  return Math.min(raw, policy.maxDelayMs)
}

/** 一次即将执行的重试。 */
export interface McpReconnectAttempt {
  /** 第几次尝试，从 1 开始。 */
  attempt: number
  /** 本次尝试之前已经等待的毫秒数。 */
  delayMs: number
  /** 本次之后还剩几次预算。 */
  remaining: number
}

export type McpReconnectPlan =
  | { scheduled: true; attempt: number; delayMs: number }
  /** 预算已用尽：attempts 是这条链一共试过的次数。 */
  | { scheduled: false; attempts: number }

interface McpReconnectState {
  attempts: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * 按 serverId 维护退避定时器与已用次数。
 *
 * 约定：`cancel()` 同时清定时器**并重置次数**，所以它只能由「连接世代真的变了」的
 * 路径调用（手动 connect/reconnect、disconnect、remove、连接成功）。重试自身触发时
 * 绝不能走 cancel，否则预算永远回到 0，上限形同虚设。
 */
export class McpReconnectScheduler {
  private readonly policy: McpReconnectPolicy
  private readonly states = new Map<string, McpReconnectState>()

  constructor(policy: Partial<McpReconnectPolicy> = {}) {
    this.policy = { ...DEFAULT_MCP_RECONNECT_POLICY, ...policy }
  }

  /**
   * 安排下一次重试。已有挂起定时器时先取消再重排（次数不回退）。
   * 预算耗尽时不排定时器，并把状态清掉 —— 调用方据此落永久失败。
   */
  schedule(serverId: string, run: (attempt: McpReconnectAttempt) => void): McpReconnectPlan {
    const state = this.states.get(serverId) ?? { attempts: 0, timer: undefined }
    this.states.set(serverId, state)
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }

    if (state.attempts >= this.policy.maxAttempts) {
      this.states.delete(serverId)
      return { scheduled: false, attempts: state.attempts }
    }

    const delayMs = mcpReconnectDelayMs(state.attempts, this.policy)
    const attempt = state.attempts + 1
    state.timer = setTimeout(() => {
      // 定时器落地时状态已被换掉 = 这次触发属于上一条链，丢弃。
      // （clearTimeout 之外的第二道保险，成本一个引用比较。）
      if (this.states.get(serverId) !== state) return
      state.timer = undefined
      state.attempts = attempt
      run({ attempt, delayMs, remaining: this.policy.maxAttempts - attempt })
    }, delayMs)
    return { scheduled: true, attempt, delayMs }
  }

  /** 取消挂起的重试并重置次数。返回是否真的取消掉了一个定时器。 */
  cancel(serverId: string): boolean {
    const state = this.states.get(serverId)
    if (!state) return false
    this.states.delete(serverId)
    if (state.timer === undefined) return false
    clearTimeout(state.timer)
    return true
  }

  /** 是否有挂起（尚未触发）的重试。 */
  pending(serverId: string): boolean {
    return this.states.get(serverId)?.timer !== undefined
  }

  /** 这条重连链已经用掉的次数。 */
  attempts(serverId: string): number {
    return this.states.get(serverId)?.attempts ?? 0
  }

  get maxAttempts(): number {
    return this.policy.maxAttempts
  }
}

const DETAIL_MAX_CHARS = 2_000

/** 预算耗尽后写进 snapshot.error 的中文说明。与永久失败文案同一句式。 */
export function mcpReconnectExhaustedMessage(attempts: number, detail: string): string {
  return `连接反复失败，需要人工介入：已自动重连 ${attempts} 次仍未成功，已停止重试。`
    + `最后一次失败：${truncate(detail, DETAIL_MAX_CHARS)}`
}
