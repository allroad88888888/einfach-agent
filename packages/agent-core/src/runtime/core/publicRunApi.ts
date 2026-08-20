// 把仓内的装配期注册面 PluginApi 投影成外部插件看得见的 PluginRunApi。
// ---------------------------------------------------------------------------
// 做两件事，都是投影：
//   1) **同一批 hook 槽的转接**——外部插件注册的 hook 拿到的是不含 Store 的 PluginHookContext，
//      注册出去的是 loop 认识的 LoopHooks 实现，返回值原样透传（这是 F2 卡的要害：从前这里把
//      afterToolCall 的返回值写死成 undefined，外部插件只能观察不能干预）；
//   2) **把 CoreCtx 的两个 store 投影成受限的状态读写面**（F2b）——能力给，裸句柄不给。
//
// 信任裁决（负责人 2026-08-20「给，同等权利」与「给，读写同理」）与「为什么不给裸 Store」的
// 完整理由写在 pluginHookContracts.ts 的文件头，不在这里复述。

import { createPluginStateAccess } from '../../state/pluginStateAccess'
import type { CoreCtx } from './coreCtx'
import type { LoopHooks } from './loopHooks'
import type { PluginApi } from './pluginApi'
import type { PluginHookContext, PluginLoopHooks } from './pluginHookContracts'
import type { PluginRunApi } from './pluginContracts'

/**
 * 冻结的一次性投影：身份、signal、stale 自查，加上受限的状态读写面——**不带 store / root / history**。
 *
 * `state` 每次投影现建一份（四个闭包的冻结对象，与建 ctx 本身同一个量级），而不是挂到 CoreCtx 上缓存：
 * 它把句柄闭进这一次 hook 调用的 ctx 里，插件拿到的写入面就不可能指向另一个会话的 store。
 * 三道写入门（ghost / stale run / abort）在**调用时**才求值，所以插件把它收起来跨 await 用也不会
 * 拿到一份已经过期的「放行」。实现与取舍见 state/pluginStateAccess.ts。
 */
function projectContext(ctx: CoreCtx): PluginHookContext {
  return Object.freeze({
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    signal: ctx.signal,
    isCurrent: () => ctx.isCurrent(),
    state: createPluginStateAccess(ctx),
  })
}

/**
 * 逐槽转接表：把一个公开 hook 实现包成 loop 认识的内部 hook 实现。
 *
 * 键取自 **`keyof LoopHooks`**（不是 `keyof PluginLoopHooks`）是刻意的：内部新增第 8 个槽而公开
 * 契约没跟上时，这张表少一项就编译失败，逼人当场决定「给不给外部插件」，而不是让两边的面
 * 又悄悄拉开差距——F2 卡要修的正是这种差距。每一项的类型也是逐槽核对的：事件形状或返回类型
 * 一旦漂移，红的是这张表而不是某个 `as`。
 */
const hookAdapters: {
  [K in keyof LoopHooks]-?: (fn: NonNullable<PluginLoopHooks[K]>) => NonNullable<LoopHooks[K]>
} = {
  onRunStart: (fn) => (ctx) => fn(projectContext(ctx)),
  transformContext: (fn) => (ctx, draft) => fn(projectContext(ctx), draft),
  prepareRequest: (fn) => (ctx, draft) => fn(projectContext(ctx), draft),
  beforeToolCall: (fn) => (ctx, ev) => fn(projectContext(ctx), ev),
  afterToolCall: (fn) => (ctx, ev) => fn(projectContext(ctx), ev),
  onTurnEnd: (fn) => (ctx, ev) => fn(projectContext(ctx), ev),
  shouldStop: (fn) => (ctx, ev) => fn(projectContext(ctx), ev),
}

/** Projects the in-repo plugin registration surface onto the public per-run API. */
export function publicRunApi(api: PluginApi): PluginRunApi {
  return {
    commands: api.commands,
    observeRun: api.observeRun,
    hook<K extends keyof PluginLoopHooks>(name: K, fn: NonNullable<PluginLoopHooks[K]>): void {
      // 唯一一次转型：泛型 K 下 TS 无法把联合类型的表项与实参对上号。表本身是逐槽类型检查过的
      // （见上），所以这里转的是「同一个槽的适配器」，不是在放弃检查。
      const adapt = hookAdapters[name] as (f: NonNullable<PluginLoopHooks[K]>) => NonNullable<LoopHooks[K]>
      api.hook(name, adapt(fn))
    },
    onAfterToolCall(listener) {
      // 保留的窄面：纯观察，返回值本就是 void，不参与结果补丁。要改写结果请用
      // hook('afterToolCall', ...)（现在它的返回值会真的生效）。
      api.hook('afterToolCall', async (_ctx, event) => {
        await listener(Object.freeze({
          callId: event.callId,
          toolName: event.toolName,
          args: Object.freeze({ ...event.args }),
          result: Object.freeze({ ...event.result }),
        }))
        return undefined
      })
    },
  }
}
