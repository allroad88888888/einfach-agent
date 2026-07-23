// 运行时句柄 CoreCtx（PX1）—— 每个 hook / 插件动作在运行时拿到的唯一句柄。
// ---------------------------------------------------------------------------
// 契约（core-plugin-extraction-blueprint §二 PX1）：状态一律从这里的 store/root 取，不穿参。
//   · 读：ctx.store.getter(itemsAtom) / ctx.root.getter(sessionsAtom)[ctx.sessionId]，随取随用。
//   · 写：ctx.store.setter(atom, next) 裸给；异步写前 `if (!ctx.isCurrent()) return` 自查。
//   · store 就是 getSessionStore(id).store（einfach 会话 store），root 就是 rootStore（跨会话）。
// 本文只定义句柄形状 + 组装器，绝不 import observability 具体实现 —— traceEvent 由构造时注入
// （modelRun 那侧把它现有的 traceEvent 闭包传进来），让 core 与埋点实现解耦、便于测试注入假的。

import type { Store } from '@einfach/core'
import { sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'

// 简介：trace 出口回调的形状。
// 详情：与 modelRun.ts 里现有的 `traceEvent(name, attrs?)` 闭包逐字同形 —— attrs 就是
//   observability 的 TraceAttributes（= Record<string, unknown>），故现有闭包可直接注入，
//   而 CoreCtx 本身无需 import observability，保持 core 对埋点实现的零依赖。
export type TraceEventFn = (name: string, attrs?: Record<string, unknown>) => void

// 简介：运行时句柄（PX1）。状态从 store/root 取，不穿参。
export interface CoreCtx {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
  // einfach 会话 store（getSessionStore(id).store）：getter/setter 覆盖会话原子
  // （itemsAtom / runAtom / checkpointsAtom / ...）。
  readonly store: Store
  // 跨会话顶层 store（rootStore）：sessionsAtom / activeSessionIdAtom。
  readonly root: Store
  /** ghost + stale-run 双查。只有「await 之后再写」的异步插件需要调；循环内 hook 由 loop 守卫覆盖。 */
  isCurrent(): boolean
  /** 发一条 trace 事件（压缩等插件要发和现在逐字一样的 llm.* 事件）。实现由构造时注入。 */
  traceEvent(name: string, attrs?: Record<string, unknown>): void
}

// 简介：stale-run + ghost 双查的纯函数（现有 modelRun.isCurrentRun 的等价搬迁）。
// 详情：会话仍登记（root.getter(sessionsAtom)[sessionId] 存在）、且该会话当前 run 就是本次 runId
//   （store.getter(runAtom)?.runId === runId，未被新 run 顶掉）。store/root 由外部注入 —— 不读
//   模块单例（rootStore / getSessionStore），便于用假 store 单测两条分支。
export function isCurrentRun(deps: {
  root: Store
  store: Store
  sessionId: string
  runId: string
}): boolean {
  if (!deps.root.getter(sessionsAtom)[deps.sessionId]) return false
  return deps.store.getter(runAtom)?.runId === deps.runId
}

// 简介：makeCoreCtx 的注入依赖。
// 详情：store/root/traceEvent 全部注入 —— 测试可传假 store / 假 traceEvent，运行时由 modelRun
//   传 getSessionStore(id).store、rootStore、以及它自己的 traceEvent 闭包。
export interface MakeCoreCtxDeps {
  sessionId: string
  runId: string
  signal: AbortSignal
  store: Store
  root: Store
  traceEvent: TraceEventFn
}

// 简介：组装一个 CoreCtx（PX1 构造器）。
// 详情：字段原样透出；isCurrent() 闭合到本次 (root, store, sessionId, runId) 上调 isCurrentRun；
//   traceEvent 直接透传注入的回调（保留函数身份，便于测试断言收到的 name/attrs）。
export function makeCoreCtx(deps: MakeCoreCtxDeps): CoreCtx {
  return {
    sessionId: deps.sessionId,
    runId: deps.runId,
    signal: deps.signal,
    store: deps.store,
    root: deps.root,
    isCurrent: (): boolean =>
      isCurrentRun({
        root: deps.root,
        store: deps.store,
        sessionId: deps.sessionId,
        runId: deps.runId,
      }),
    traceEvent: deps.traceEvent,
  }
}
