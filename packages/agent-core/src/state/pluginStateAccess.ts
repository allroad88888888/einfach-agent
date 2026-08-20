// 外部插件状态读写面的实现 —— 绑在一次 hook 调用的运行时句柄上。
// ---------------------------------------------------------------------------
// 形状与取舍在 runtime/core/pluginStateContracts.ts；本文件只回答两件事：值从哪里取、写入怎么入账。
//
// ## 为什么物理落点在 state/
//
// `pnpm check:state` 规则 2 认的是「写会话 atom 的那一行落在哪个目录」，允许的只有 core 的
// `state/` 与 `runtime/commands/`。外部插件的写入实现放在这里，规则 2 才管得着它；放进
// `runtime/core/`（契约文件旁边，看着更内聚）则是把一条会话状态写入路径搬到门禁管辖之外 ——
// 即便今天它只是转调 writeSlot，下一个人往里加一行 `store.setter(...)` 时也没有任何东西会喊。
//
// ## 为什么不复用 sessionWriters 的 store-scoped 写入器
//
// `appendItemToSession` / `setContextCheckpointOnSession` 与这里的两条写入逐字同义，但
// `state/sessionWriters.ts` import 了 `runtime/core/coreInstance` 与 `state/rootStore`，而本文件被
// `runtime/core/publicRunApi.ts` 引用、publicRunApi 又在 `coreInstance → pluginHost` 的静态导链上。
// 走一趟 sessionWriters 就成环，且环的落点是 `rootStore.ts` 顶层那句 `defaultCore.rootStore` ——
// coreInstance 还没初始化完就被读，症状是加载期崩溃而不是类型错误。所以这里直接用同一层原语
// （`writeSlot` / `appendItemLogged`），与那两个写入器**并列**，不是绕过它们。

import type { History, Store } from '@einfach/core'
import type { ModelItem } from '@einfach-agent/ai'
import { newId } from '../runtime/newId'
import type {
  PluginRootView,
  PluginSessionView,
  PluginStateAccess,
} from '../runtime/core/pluginStateContracts'
import type { ContextCheckpoint } from './contextCheckpoint.type'
import type { ConversationItem } from './core.type'
import { activeSessionIdAtom, activeWorkspaceRootAtom } from './rootAtoms'
import { contextCheckpointAtom, itemsAtom, runAtom } from './sessionAtoms'
import { appendItemLogged } from './sessionItemsLog'
import { SESSION_SLOTS } from './sessionSlots'
import { writeSlot } from './sessionSlotWrite'

/**
 * 建一个状态读写面所需要的运行时句柄。
 *
 * 刻意用结构类型：`CoreCtx` 天然满足它（store / root / history / signal / isCurrent 五样它都带），
 * 于是接线处不需要再拆一遍字段，测试也能传一个手搭的最小句柄。
 */
export interface PluginStateHost {
  readonly store: Store
  readonly root: Store
  readonly history: History
  readonly signal: AbortSignal
  isCurrent(): boolean
}

/**
 * 会话侧读取器表。按 `keyof PluginSessionView` 取键：契约里加一个键而这里没跟上会直接编译失败，
 * 不会出现「契约说读得到、实现里没有」的静默缺口。
 */
const sessionReaders: {
  [K in keyof PluginSessionView]: (store: Store) => PluginSessionView[K]
} = {
  // 冻结的是外层数组：条目对象仍与 store 共享引用（深冻结每次读都要 O(对话长度)，
  // 而它挡的那件事已经由 `readonly ConversationItem[]` 在类型上说清了）。
  items: (store) => Object.freeze([...store.getter(itemsAtom)]),
  run: (store) => {
    const run = store.getter(runAtom)
    return run === undefined ? undefined : Object.freeze({ runId: run.runId, status: run.status })
  },
  contextCheckpoint: (store) => {
    const checkpoint = store.getter(contextCheckpointAtom)
    return checkpoint === undefined ? undefined : Object.freeze({ ...checkpoint })
  },
}

/** 跨会话侧读取器表。同上，键取自 `keyof PluginRootView`。 */
const rootReaders: {
  [K in keyof PluginRootView]: (root: Store) => PluginRootView[K]
} = {
  activeSessionId: (root) => root.getter(activeSessionIdAtom),
  activeWorkspaceRoot: (root) => root.getter(activeWorkspaceRootAtom),
}

/**
 * 写入前的三道门，与仓内写入器逐条对齐（CLAUDE.md：「writer 和 await 后回写必须保留 ghost guard、
 * runId stale guard 与 AbortSignal 检查」）：
 * · ghost guard + runId stale guard —— `isCurrent()` 一次查两件（runtime/shared/runGuards.ts：
 *   会话仍登记在 root 的会话表里，且 `runAtom.runId` 仍是这次 run）；
 * · AbortSignal —— run 已中止就不该再往这个会话里写。
 *
 * 门开在**调用时**而不是 hook 进入时：外部插件在 await 之后回写也照样过这三道，忘记先调
 * `isCurrent()` 也写不进一个已经被撤销或切换掉的会话。
 */
function writable(host: PluginStateHost): boolean {
  return host.isCurrent() && !host.signal.aborted
}

/** 把一个运行时句柄投影成外部插件的受限状态读写面。 */
export function createPluginStateAccess(host: PluginStateHost): PluginStateAccess {
  return Object.freeze({
    readSession<K extends keyof PluginSessionView>(key: K): PluginSessionView[K] {
      // 唯一一次转型：泛型 K 下 TS 无法把联合类型的表项与返回类型对上号。表本身是逐键类型
      // 检查过的（见上），转的是「同一个键的读取器」，不是在放弃检查。
      const read = sessionReaders[key] as (store: Store) => PluginSessionView[K]
      return read(host.store)
    },
    readRoot<K extends keyof PluginRootView>(key: K): PluginRootView[K] {
      const read = rootReaders[key] as (root: Store) => PluginRootView[K]
      return read(host.root)
    },
    appendItem(item: ModelItem): string | undefined {
      if (!writable(host)) return undefined
      // id 与 createdAt 由 core 生成：增量 applier 按 id 定位自己那一条，撞 id 会让 undo 改错内容，
      // 这条约束不能外包给第三方（见契约文件 appendItem 的说明）。
      const entry: ConversationItem = { id: newId(), createdAt: Date.now(), item }
      appendItemLogged(host, entry)
      return entry.id
    },
    setContextCheckpoint(checkpoint: ContextCheckpoint | undefined): boolean {
      if (!writable(host)) return false
      writeSlot(host, SESSION_SLOTS.contextCheckpoint.key, contextCheckpointAtom, checkpoint)
      return true
    },
  })
}
