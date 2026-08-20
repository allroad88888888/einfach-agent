// 外部插件的状态读写面 —— 一张可枚举的投影清单 + 两条具名写入，不是裸 Store。
// ---------------------------------------------------------------------------
// 裁决（负责人 2026-08-20「给，读写同理」，issue 卡 F2b）：外部插件既能读会话与跨会话状态，
// 也能改会话状态。姿态与 A6「同等权利 / 插件一视同仁」一致；F2 当时只落了 hook 对等，这里补另一半。
//
// 仍然不给的只有一样东西：**einfach 的裸 `Store` 句柄**。理由不是信任——信任姿态已经是
// 「装插件 = 完全信任」（见 pluginHookContracts.ts 文件头），而是记账：会话状态的每一次写入都要在
// 事务日志里留下 `(key, prev, next)`，而 `pnpm check:state` 规则 2 只能扫仓库里的源码，磁盘上被
// 动态加载的插件它看不见。裸 Store 交出去就等于开一条门禁永远看不见的写入路径，绕过日志的写入
// 会让 undo 只回滚一部分状态，且只在 undo/崩溃恢复时才以静默错值浮出来。仓内 UI 同样是完全信任
// 的代码，照样只能走 commands —— 这是记账的机械要求，对谁都一样。
//
// ★ 为什么是 string 键的投影表，而不是把 atom 引用导出去 ★
// 导出 atom 引用看着更直接，但它把 atom 身份本身变成兼容承诺：默认值、派生关系、以及「这个 atom
// 住在哪个 store」全都跟着进公开面。而第三方拿到引用之后能做的**读**并不比键表多一分，能做的
// **写**仍然必须回到 core 的写入器（否则不入账）—— 多出来的只有出错的方式：会话 atom 一旦流到
// 渲染层被裸 `useAtomValue` 读，拿到的是界面 store 里的默认值，组件照常渲染一份空状态、不抛异常
// （CLAUDE.md 规则 5）。键表把公开的东西收敛成一份能枚举、能逐项加注释的清单：加一项是加一行，
// 减一项是破坏性变更，两边都看得见。
//
// ★ 为什么读是一张键表、写是两条具名方法（形状刻意不对称）★
// 读的机制只有一种：取一个投影。写不是 —— `items` 随对话无界增长，只能走增量 op；
// `contextCheckpoint` 有界，走整值记账。两者的日志载荷、逆操作和开销量级都不同（state/listSlotLog.ts
// 的实测：整值记账 items 是二次开销，0.32 MB 的对话落盘要写 33 MB）。一个统一的
// `writeSession(key, value)` 会把这个差别抹平，于是「给 items 补一个整值 setter」看起来只是往表里
// 加一行 —— 而那正是 check:state 规则 3 要防的东西。具名方法让**「items 只有 append、没有整值
// setter」成为结构性事实**，而不是一条要靠 review 记住的约定。
//
// ★ 拒绝用返回值表达，不抛异常 ★
// 与 PluginCommandFacade.stopCurrentRun 同款：run 已经不是当前 run、或已中止时，写入返回
// false / undefined。hook 里抛异常会被 pluginCircuitBreaker 计入连续失败并最终停用该插件，
// 而「你回写晚了一步」不是插件的错。
//
// ★ 挂在 PluginHookContext 上，不挂在 PluginRunApi 上 ★
// 见 pluginHookContracts.ts 里 PluginHookContext.state 那一段：三道写入门（ghost / stale run /
// abort）恰好就是 CoreCtx 已经带着的那三样，挂在 ctx 上是复用它们，挂在 run 级 API 上则要照着
// 再造一份同款判据 —— 两份判据迟早漂移，而漂移的方向是「写入门变松」。

import type { ModelItem } from '@einfach-agent/ai'
import type { ContextCheckpoint } from '../../state/contextCheckpoint.type'
import type { ConversationItem } from '../../state/core.type'
import type { PluginRunSnapshot } from './pluginContracts'

/**
 * 会话状态的公开投影清单：`readSession(key)` 的键与它的返回类型。
 *
 * **不是会话 atom 的全集，也不打算是**：这里每加一项都是一条兼容承诺，所以按「第三方真的要拿它
 * 做决定」逐项开。当前三项覆盖了两类形状 —— 内容型（items）、单值型（run / contextCheckpoint），
 * 扩表时照着同一条判据走即可。
 *
 * 冻结只到**外层**：`items` 返回的是一份冻结的浅拷贝，条目对象仍是与 store 共享的引用。深冻结
 * 的代价是 `O(对话长度)` 且每次读都要付，而它挡住的是「插件就地改了一条 item」这种本来就该由
 * 类型（`readonly`）说清的事。别就地改条目：那既不入账，也绕过了 store 的变更通知。
 */
export interface PluginSessionView {
  /** 当前会话的对话历史（冻结的浅拷贝，按时间序）。 */
  items: readonly ConversationItem[]
  /**
   * 当前 run 的公开投影；无 run 时 undefined。
   *
   * 刻意复用 `observeRun` 那一份 `PluginRunSnapshot`，而不是另开一个更宽的 run 视图：两处若给出
   * 不同形状的「run」，插件就得分辨自己手上是哪一份，而 RunState 里的待确认载荷与错误正文本来
   * 就不在公开面内（见 pluginContracts.ts 对 PluginRunSnapshot 的说明）。
   */
  run: PluginRunSnapshot | undefined
  /** 已生成的上下文压缩摘要；尚未压缩过时 undefined。与 setContextCheckpoint 写的是同一个槽位。 */
  contextCheckpoint: Readonly<ContextCheckpoint> | undefined
}

/**
 * 跨会话（core 的 root store）状态的公开投影清单。
 *
 * 与会话面分开成两个方法而不是合并成一张表：两者住在**不同的 store** 里，合并会让「这个键读的是
 * 哪个 store」变成要查表才知道的事，而那正是 CLAUDE.md 里反复强调、放错就静默读到默认值的那条缝。
 */
export interface PluginRootView {
  /** 当前激活的会话 id；无激活会话时是空串。 */
  activeSessionId: string
  /** 当前工作区的根目录；未创建工作区时 undefined。 */
  activeWorkspaceRoot: string | undefined
}

/** 外部插件的受限状态读写面。读随取随用，写要过三道门（见实现文件的 guard 说明）。 */
export interface PluginStateAccess {
  /** 读一个会话状态投影。读不设门 —— 会改变世界的是写。 */
  readSession<K extends keyof PluginSessionView>(key: K): PluginSessionView[K]
  /** 读一个跨会话状态投影。 */
  readRoot<K extends keyof PluginRootView>(key: K): PluginRootView[K]
  /**
   * 往对话历史尾部追加一条，只记这一条的增量账。返回新条目的 id；被门挡下时返回 undefined。
   *
   * **items 只有 append，没有整值 setter**，理由见文件头「形状刻意不对称」那一段。
   * id 与 createdAt 由 core 生成：让插件自己造 id 等于把「id 得全局唯一且能被增量 applier 按 id
   * 定位」这条约束外包给第三方，撞 id 的后果是 undo 改错一条内容。
   */
  appendItem(item: ModelItem): string | undefined
  /**
   * 写入（或用 `undefined` 清空）上下文压缩摘要，整值记账，日志里留下 `(key, prev, next)`。
   *
   * 开这一条而不是别的有界槽位：压缩是**唯一**一条已经被裁决为「可以由外部替换」的横切行为
   * （compactionPlugin 已删，真跑的是 modelTurnRequester.ts 内联的 checkpoint 蒸馏），第三方要
   * 做自定义压缩，能写的就是这个槽位。`run` / `plan` 是 loop 与计划运行时的状态机，整值改写它们
   * 不是「同等权利」而是让循环踩空——要停 run 用 `commands.stopCurrentRun()`。
   *
   * 返回 true 表示写入被接受；值与当前值相同时 writeSlot 会整体短路（不开事务、不记账），
   * 此时仍返回 true —— 「没有变化」不是拒绝。
   */
  setContextCheckpoint(checkpoint: ContextCheckpoint | undefined): boolean
}
