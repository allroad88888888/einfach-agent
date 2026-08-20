// 外部（第三方）插件的 loop hook 契约：与仓内 AgentPlugin **同一批 7 个槽**，只把运行时句柄
// CoreCtx 换成不含 Store 的受限投影。事件与返回值的形状与 loopHooks.ts 逐字复用，不另造一套。
// ---------------------------------------------------------------------------
// ★ 这是一次有意的信任裁决，不是遗漏 ★
//
// 依据：负责人 2026-08-20 的裁决「给，同等权利」（.project-lines/questions.md A6，
// docs/project-lines-verdicts-issues.md 的 F2 卡）。追问点原文是「beforeToolCall 能返回 block
// 拦下工具调用，第三方拿到它等于能否决 shell 命令、也能改模型看到的上下文」——答复是给。
// 因此本文件把这两件事都放开了：
//   · beforeToolCall 返回 `{ block: true }` 会真的拦下那次工具执行（loop 侧 toolCallPluginHooks.ts
//     把它变成一条 `code: 'plugin_blocked'` 的确定结果回给模型，工具的 execute 不会被调用）；
//   · transformContext / prepareRequest 拿到的 draft.messages 就是「模型这一轮看到的东西」，
//     就地改即生效（不写回 itemsAtom，见 loopHooks.ts 对 RequestDraft 的说明）。
//
// 采取的信任姿态 = **「装插件 = 完全信任」**（issue 卡 F2 的选项 b），不新增 MCP 起进程那样的
// 逐插件确认门。理由必须诚实写出来：
//   1. 与 core 侧既有事实一致——插件加载状态机早就按「目录存在即信任」删掉了 pending_consent
//      （见 pluginLoaderTypes.ts 头注释），core 侧本来就不做确认门；
//   2. 补一道只挡 hook 的确认门是安全剧场：插件入口是宿主用 `import()` / blob 求值的**同权代码**，
//      它不经过任何 hook 也能直接 fetch、触达宿主命令桥、读写 DOM
//      （docs/plugin-ecosystem-blueprint.md §3.4：capabilities 是申报，不是沙箱）。真正的隔离要
//      worker/iframe 沙箱，那是另一件事，不是本槽位的确认弹窗能替代的；
//   3. 用户的控制点是「装不装」+ 设置面板的逐插件启停，所以**安装面必须把这句话说出来**：
//      apps/web/src/agentNew/ui/PluginSettingsPanel.tsx 的信任提示、docs/plugin-quickstart.md
//      的「当前边界」、docs/plugin-ecosystem-blueprint.md §9 第 1 条的裁决记录。
//
// ★ 状态的读与写也一起放开了（F2b，负责人 2026-08-20「给，读写同理」）★
// 早一版的这段写的是「本契约不给 store / root / history……写入面不建议开」。裁决之后事实变了：
// 读会话与跨会话状态、改会话状态，外部插件都拿得到，入口是下面 PluginHookContext 的 `state`
// （契约见 pluginStateContracts.ts，实现在 state/pluginStateAccess.ts）。
//
// **仍然不给的只有 einfach 的裸 `Store` 句柄**，而且理由与信任无关 —— 信任姿态已经是上面那句
// 「装插件 = 完全信任」。理由是记账：会话 atom 的写入必须收口在 core 的 `state/` 与
// `runtime/commands/`（CLAUDE.md 状态与 UI 边界规则 2，由 `pnpm check:state` 机械判定），而门禁
// 扫的是仓库里的源码、扫不到磁盘上被动态加载的插件。把 Store 交出去就等于开一条门禁永远看不见
// 的写入路径：绕过事务日志的写入会让 undo 只回滚一部分状态，越过它的那个 atom 停在新值上，
// 而这件事只在 undo 或崩溃恢复时才以静默错值浮出来。仓内 UI 同样是完全信任的代码，照样只能走
// commands —— 对谁都一样，这是机械要求，不是姿态。
// 于是「给能力」与「留住记账」两件事都要，答案就是受限 facade：能力经 `state`（会话状态）与
// `commands`（run 控制）给出，每一条的写入实现都物理落在 core 的写入器层，日志照记。

import type { PluginStateAccess } from './pluginStateContracts'
import type { ToolResultPatch } from '../toolResultPatch'
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  RequestDraft,
  ShouldStopDecision,
  TurnEndDecision,
  TurnEndEvent,
} from './loopHooks'

export type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  RequestDraft,
  ShouldStopDecision,
  TurnEndDecision,
  TurnEndEvent,
} from './loopHooks'
export type { ToolResultPatch } from '../toolResultPatch'

/**
 * CoreCtx 的受限投影：够写「异步回写前自查是否仍是当前 run」与「跟随 abort」，但不含 Store。
 *
 * 字段取舍逐条对应上面那段裁决：
 * · sessionId / runId —— 归因与自查；
 * · signal —— 插件里的异步等待要能跟着 run 一起中止，否则停止 run 之后它还在跑；
 * · isCurrent() —— 与仓内插件同款的 ghost + stale-run 双查，await 之后再动手前必须调；
 * · state —— 会话与跨会话状态的受限读写面（F2b）。不给 store / root / history 这三个裸句柄，
 *   理由见上面那段：能力给了，记账不能丢；
 * · 不给 traceEvent —— 那会让第三方插件能伪造 core 自己的 `agent.plugin_*` 事件名，
 *   把「哪个插件干的」这条归因线搅浑，而它对本卡的能力面没有贡献。
 */
export interface PluginHookContext {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
  isCurrent(): boolean
  /**
   * 会话与跨会话状态的受限读写面。
   *
   * **挂在 ctx 上、不挂在 PluginRunApi 上**是刻意的：写入要过的三道门（ghost guard、runId stale
   * guard、AbortSignal）恰好就是本 ctx 已经带着的那三样，挂在这里是复用它们，挂在 run 级 API 上
   * 则要照着再造一份同款判据 —— 两份判据迟早漂移，而漂移的方向是「写入门变松」。
   *
   * 代价是它只在 hook 里拿得到：要在 `observeRun` 或 `activate` 里读状态，就在 `onRunStart` 里把
   * ctx 收起来接着用（ctx 是冻结的、三道门在**调用时**才求值，所以拿着不会过期成假的放行）。
   */
  readonly state: PluginStateAccess
}

/**
 * 公开插件可注册的 7 个槽。名字、事件形状、返回语义与 loopHooks.ts 的 LoopHooks 完全一致；
 * fan-out 合成语义也共用同一套（pluginApi.ts 的 assemblePlugins），因此外部插件与仓内插件
 * 在同一批注册序里竞争，谁先注册谁先跑。
 *
 * 与 LoopHooks 的对齐由 publicRunApi.ts 的转接表**编译期**保证：那张表按 `keyof LoopHooks` 取键，
 * 内部新增一个槽而这里没跟上会直接编译失败，不会静默变回「外部插件的面比仓内小」。
 */
export interface PluginLoopHooks {
  /** run 开始、第一轮请求之前调一次。 */
  onRunStart?(ctx: PluginHookContext): void | Promise<void>
  /** 组请求前变换上下文：就地改 draft.messages，只影响本轮请求体，不写回历史。 */
  transformContext?(ctx: PluginHookContext, draft: RequestDraft): void | Promise<void>
  /** 发请求前再改一次投影。 */
  prepareRequest?(ctx: PluginHookContext, draft: RequestDraft): void | Promise<void>
  /** 工具执行前。返回 `{ block: true, reason }` 拦下这次执行（首个 block 胜、短路）。 */
  beforeToolCall?(
    ctx: PluginHookContext,
    ev: BeforeToolCallEvent,
  ): BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>
  /** 工具执行后。只能返回可验证的结果补丁（不能改 ok / pause 分支）。 */
  afterToolCall?(
    ctx: PluginHookContext,
    ev: AfterToolCallEvent,
  ): ToolResultPatch | undefined | Promise<ToolResultPatch | undefined>
  /** 一轮 model 往返结束。返回完整 TurnEndStopDecision 可要求 loop 带状态终止 run。 */
  onTurnEnd?(
    ctx: PluginHookContext,
    ev: TurnEndEvent,
  ): void | TurnEndDecision | Promise<void | TurnEndDecision>
  /** 本轮结束后是否显式停止。undefined 继续；决定要通过 loop 侧的运行时校验。 */
  shouldStop?(
    ctx: PluginHookContext,
    ev: TurnEndEvent,
  ): ShouldStopDecision | undefined | Promise<ShouldStopDecision | undefined>
}
