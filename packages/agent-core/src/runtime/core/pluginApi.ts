// 插件与注册面 PluginApi + 装配（PX2）—— 单槽 hook → 多订阅 fan-out；registerTool + subscribe 注册面（Stage 3）。
// ---------------------------------------------------------------------------
// 契约（core-plugin-extraction-blueprint §三 PX2）：插件是 (api: PluginApi) => void | Dispose；
//   api 是【装配期】的注册面，运行时行为通过它注册的 hook / tool / 订阅意向生效。core 永远不认识插件 ——
//   assemblePlugins 把多个插件注册的同名单槽 hook 合成一个复合 hook 交给 loop（PX3 fan-out）；
//   registerTool 收集的 tool 列表、subscribe 收集的订阅意向，随同一份返回值（AssembledPlugins）
//   一并交给消费方落地——消费方决定 tools 进哪个 ToolRegistry、何时调 bindSubscriptions(store)。
//
// Stage 3（本文件）新增 registerTool + subscribe。registerRenderer（涉及 UI，React 组件按 timeline
// 类型注册）留到后续 Stage；commands 的取舍见下方 CommandApi 附近的说明（转发会成环，本 Stage 只定类型）。

import type { Atom, Store } from '@einfach/core'
import type { AskUserAnswerValue } from '../../state/transientAtoms'
import type { Tool } from '../../tools/types'
import type { CoreCtx } from './coreCtx'
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  LoopHooks,
  RequestDraft,
  TurnEndDecision,
  TurnEndEvent,
} from './loopHooks'

// 简介：commands 访问器的目标形状（PX2 imperative actions）——手写镜像 runtime/commands.ts 现有
//   导出的部分签名（sendMessage/answerQuestion/revertToTurn/stopRun），不 import 该文件。
// 详情：非穷举——只挑最常用的几个对齐类型；真正接线时按需扩展、并与 commands.ts 实际签名核对
//   （手写意味着两边可能悄悄漂移，这是刻意避开下方 import 环的代价，接线那一刻必须回读 commands.ts
//   核对一遍）。本 Stage 没有任何字段引用这个类型（PluginApi 上没有 commands 字段，见下方 PluginApi
//   的 TODO 注释），纯为未来接线预留形状。
export interface CommandApi {
  sendMessage(input: string): void
  answerQuestion(questionId: string, value: AskUserAnswerValue): void
  revertToTurn(turnIndex: number): void
  revertTurnToDraft(turnIndex: number): void
  stopRun(): void
}

// 简介：装配期注册面（PX2）。
// 详情：hook 累积单槽实现供 fan-out；registerTool 累积插件要挂给 model 的工具；subscribe 只记
//   「插件想观察哪个 atom」的意向——装配期没有运行时 store，真正的 store.sub() 推迟到 loop 侧调用
//   assemblePlugins 返回值上的 bindSubscriptions(store)（见下方 AssembledPlugins，PX5）。
export interface PluginApi {
  hook<K extends keyof LoopHooks>(name: K, fn: NonNullable<LoopHooks[K]>): void
  /** 注册一个 LLM 可调工具。消费方（loop/宿主）决定把 AssembledPlugins.tools 落进哪个 ToolRegistry；
   *  本 API 不直接碰任何全局 toolRegistry 单例（为将来多实例铺路）。 */
  registerTool(tool: Tool): void
  /** 观察型注册（PX5：观察=订阅 atom，不另造事件总线）。装配期只记意向，真正订阅在
   *  bindSubscriptions(store) 时才发生——见 AssembledPlugins。
   *  ★ 蓝图偏离（有意，非遗漏）★：蓝图 PX2 §三写的是 fn:(v, ctx)=>void——回调带 CoreCtx，
   *  让观察者能顺手读别的 atom / 查 isCurrent。本 Stage 该 API 还【没接进 loop】（bindSubscriptions
   *  只在无头验证测试里被调），此刻 loop 侧 ctx 怎么喂进来尚未定形，故先简化成 (value)=>void，
   *  不提前把未用 API 的形状焊死。等 subscribe 真正接进 modelRun 时（那时 ctx 现成），再补成
   *  (value, ctx)=>void + bindSubscriptions(ctx)——届时 2 处测试调用点跟着改即可。别以为这是漏了。 */
  subscribe<T>(atom: Atom<T>, fn: (value: T) => void): void
  // TODO(Stage 3+): registerRenderer —— 涉及 UI（React 组件按 timeline 类型注册），留到后续 Stage。
  // TODO(commands)：蓝图 §三 PX2 设想 PluginApi 上还有一个 `commands: CommandApi`（转发 sendMessage/
  //   answerQuestion/revertToTurn 等到 runtime/commands.ts）。本 Stage 没有接进来——commands.ts 除了
  //   自解析全局 store，还 `import { runSession, runToolLoop } from './modelRun'`，而 modelRun.ts 又
  //   `import { assemblePlugins } from './core/pluginApi'`（本文件）。一旦本文件反过来 import
  //   commands.ts，就是一个闭合环：
  //     pluginApi.ts → commands.ts → modelRun.ts → pluginApi.ts
  //   诚实优先：本 Stage 只在上方定义 CommandApi 这个【目标形状】（手写、零依赖边，不 import
  //   commands.ts），不在 PluginApi 上挂 commands 字段——挂了却给不出真实现是比不挂更糟的半成品
  //   （调用方会以为能用）。等「实例化」阶段（蓝图 §八·4：commands 不再自解析模块级单例、而是随
  //   core 实例注入）这个环会自然断开，届时把 CommandApi 接成 PluginApi 的真字段、assemblePlugins
  //   里转发过去即可。
}

// 简介：一个插件 = 装配期拿到 api 做注册的函数；可选返回一个 dispose。
// 详情：本 Stage 的 assemblePlugins 只消费其注册副作用；dispose 的聚合留到实例化阶段（蓝图 §八·4）。
export type AgentPlugin = (api: PluginApi) => void | (() => void)

// 每个槽的登记 bucket：同名 hook 多次注册累积成数组，保持注册序。
// -?：LoopHooks 的字段全是可选（?），映射类型默认继承这个可选修饰符，会让 buckets.xxx 被推成
// `...[] | undefined`——但 createHookBuckets() 总是把七个槽全部初始化好，运行时形状从不缺字段，
// 用 -? 抹掉继承来的可选修饰符，类型与实际运行时保证的「必存在」对齐（纯类型标注改动，无行为变化）。
type HookBuckets = {
  [K in keyof LoopHooks]-?: NonNullable<LoopHooks[K]>[]
}

function createHookBuckets(): HookBuckets {
  return {
    onRunStart: [],
    transformContext: [],
    prepareRequest: [],
    beforeToolCall: [],
    afterToolCall: [],
    onTurnEnd: [],
    shouldStop: [],
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 简介：afterToolCall 的字段级覆盖合并（omit 保留原值）。
// 详情：patch 为 undefined → 保留 acc（该 hook 不改结果）；acc/patch 任一非 plain object → patch
//   整体替换 acc（无「字段」可保留）；两者皆 plain object → 逐字段覆盖，但值为 undefined 的字段
//   视作 omit、保留 acc 的原值（与 pi 的 afterToolCall 字段合并同口径）。
function mergeAfterToolResult(acc: unknown, patch: unknown): unknown {
  if (patch === undefined) return acc
  if (!isPlainObject(acc) || !isPlainObject(patch)) return patch
  const merged: Record<string, unknown> = { ...acc }
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value !== undefined) merged[key] = value
  }
  return merged
}

// 简介：装配期收集的一条「订阅意向」——把 subscribe<T> 的类型擦除进异质列表。
// 详情：atom/fn 成对入列（同一次 subscribe() 调用产出的一对），bindSubscriptions 只会用同一个
//   atom 取值再喂给这同一个 fn——运行时类型安全由「成对入列」保证，与这里标注的 unknown 无关
//   （unknown 只是让异质 atom 类型能塞进同一个数组，纯类型层面的擦除，不改变运行时行为）。
interface SubscriptionEntry {
  atom: Atom<unknown>
  fn: (value: unknown) => void
}

// 简介：assemblePlugins 的返回值（PX2 装配产物）——在 LoopHooks 的七个复合槽之外，additive 带上
//   registerTool 收集到的 tools、以及 subscribe 收集到的订阅意向的绑定入口。
// 详情：直接扩展 LoopHooks（不是包一层 `{ hooks, tools, ... }`）——现有调用点
//   `const hooks = assemblePlugins([...]); hooks.transformContext?.(...)`（modelRun.ts）直接在
//   返回值上取七个槽，新增字段必须挂在同一个对象上才不破坏那个调用点（本 Stage 不碰 modelRun.ts，
//   这里的类型扩展对它是纯 additive：多出来的 tools/bindSubscriptions 它不读也不受影响）。
export interface AssembledPlugins extends LoopHooks {
  /** 插件注册的工具清单，按注册序（跨插件：插件数组序 → 插件内 registerTool 调用序）。消费方
   *  决定注册进哪个 ToolRegistry——本文件不直接调用任何全局 toolRegistry 单例。 */
  readonly tools: readonly Tool[]
  /**
   * 把装配期收集的 subscribe 意向绑定到运行时 store —— 真正的 store.sub() 在这里才发生
   * （PX5：装配是纯的，副作用推迟到 loop 拿到 store 之后）。可重复调用（例如同一 session store
   * 上先后两次 run 各自 assemblePlugins 一次，各自 bind 一次）；每次调用都是全新绑定，返回一个
   * 一次性反订阅【全部】意向的 dispose —— loop 侧应在该次 run 结束时调用它，否则同一 store 上
   * 会残留上一个 run 的监听器（assemblePlugins 每次 run 重新收集一批新意向，互不清理）。
   */
  bindSubscriptions(store: Store): () => void
}

// 简介：把多个插件装配成一份复合 LoopHooks + tools 清单 + 订阅绑定入口（PX2 fan-out）。
// 详情：依次执行每个插件（拿注册副作用），把同名单槽 hook 按注册序合成一个复合 hook。合成语义：
//   · onRunStart：按注册序依次 await（与 transformContext 同款——run 启动时逐个跑，无返回值）。
//   · transformContext / prepareRequest：按注册序依次 await，都能改 draft。
//   · beforeToolCall：按注册序，第一个返回 {block:true} 的胜、短路（其余不再调）。
//   · afterToolCall：按注册序串成改写管道，逐字段覆盖合并（omit 保留原值）；每环见到上一环的累积结果。
//   · onTurnEnd：按注册序依次 await；决策【合并】——第一个返回 {stop:true} 的胜、短路（其余不再调），
//     把它的 runStatus/reason 整份带出；无人 stop（含返回 void / {stop:false}）→ undefined（loop 继续）。
//   · shouldStop：任一返回 true 即 true（短路）。
//   某槽无人注册 → 该槽为 undefined（loop 侧据此跳过）。
//   · tools：跨插件累积成一个数组，无人注册 → 空数组（不是 undefined——它不是「槽」，是清单）。
//   · subscribe：只收集意向，不在此处碰任何 store；见 bindSubscriptions。
export function assemblePlugins(plugins: AgentPlugin[]): AssembledPlugins {
  const buckets = createHookBuckets()
  const tools: Tool[] = []
  const subscriptions: SubscriptionEntry[] = []

  const api: PluginApi = {
    hook<K extends keyof LoopHooks>(name: K, fn: NonNullable<LoopHooks[K]>): void {
      const bucket = buckets[name] as NonNullable<LoopHooks[K]>[]
      bucket.push(fn)
    },
    registerTool(tool: Tool): void {
      tools.push(tool)
    },
    subscribe<T>(atom: Atom<T>, fn: (value: T) => void): void {
      subscriptions.push({ atom: atom as Atom<unknown>, fn: fn as (value: unknown) => void })
    },
  }

  for (const plugin of plugins) {
    // dispose（返回值）本 Stage 不消费 —— 立缝阶段没有 teardown（蓝图 §八·4 再聚合）。
    plugin(api)
  }

  const onRunStart: LoopHooks['onRunStart'] = buckets.onRunStart.length
    ? async (ctx: CoreCtx): Promise<void> => {
        for (const fn of buckets.onRunStart) await fn(ctx)
      }
    : undefined

  const transformContext: LoopHooks['transformContext'] = buckets.transformContext.length
    ? async (ctx: CoreCtx, draft: RequestDraft): Promise<void> => {
        for (const fn of buckets.transformContext) await fn(ctx, draft)
      }
    : undefined

  const prepareRequest: LoopHooks['prepareRequest'] = buckets.prepareRequest.length
    ? async (ctx: CoreCtx, draft: RequestDraft): Promise<void> => {
        for (const fn of buckets.prepareRequest) await fn(ctx, draft)
      }
    : undefined

  const beforeToolCall: LoopHooks['beforeToolCall'] = buckets.beforeToolCall.length
    ? async (
        ctx: CoreCtx,
        ev: BeforeToolCallEvent,
      ): Promise<BeforeToolCallResult | undefined> => {
        for (const fn of buckets.beforeToolCall) {
          const result = await fn(ctx, ev)
          if (result?.block) return result
        }
        return undefined
      }
    : undefined

  const afterToolCall: LoopHooks['afterToolCall'] = buckets.afterToolCall.length
    ? async (ctx: CoreCtx, ev: AfterToolCallEvent): Promise<unknown> => {
        let acc: unknown = ev.result
        for (const fn of buckets.afterToolCall) {
          const patch = await fn(ctx, { toolCall: ev.toolCall, result: acc })
          acc = mergeAfterToolResult(acc, patch)
        }
        return acc
      }
    : undefined

  const onTurnEnd: LoopHooks['onTurnEnd'] = buckets.onTurnEnd.length
    ? async (ctx: CoreCtx, ev: TurnEndEvent): Promise<TurnEndDecision | undefined> => {
        // 决策合并：按注册序 await；第一个返回 {stop:true} 的胜、短路（其后不再调），整份带出其
        // runStatus/reason。返回 void / undefined / {stop:false} 均视作「不干预」，继续下一个。
        // 无人 stop → undefined（= void，loop 继续）。与 beforeToolCall 的「首个 block 胜」同款口径。
        for (const fn of buckets.onTurnEnd) {
          const decision = await fn(ctx, ev)
          if (decision?.stop) return decision
        }
        return undefined
      }
    : undefined

  const shouldStop: LoopHooks['shouldStop'] = buckets.shouldStop.length
    ? async (ctx: CoreCtx): Promise<boolean> => {
        for (const fn of buckets.shouldStop) {
          if (await fn(ctx)) return true
        }
        return false
      }
    : undefined

  // 简介：真正订阅发生的唯一入口（PX5）——loop 建好 ctx/store 后调用一次即完成全部 bind。
  // 详情：按收集序对每条意向调 store.sub(atom, listener)；listener 本身无参（einfach Store.sub
  //   的监听器签名如此——变更通知，不带值），当场 store.getter(atom) 现取最新值再喂给插件的 fn，
  //   不依赖任何在 bind 时就已过期的闭包快照。返回值把这批 unsub 打包成一个统一 dispose。
  function bindSubscriptions(store: Store): () => void {
    const unsubs = subscriptions.map(({ atom, fn }) => store.sub(atom, () => fn(store.getter(atom))))
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }

  return {
    onRunStart,
    transformContext,
    prepareRequest,
    beforeToolCall,
    afterToolCall,
    onTurnEnd,
    shouldStop,
    tools,
    bindSubscriptions,
  }
}
