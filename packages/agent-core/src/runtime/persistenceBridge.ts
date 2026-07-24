// D-4 · 持久化接线桥 —— runtime 写路径 ↔ 持久化 driver 之间的 fire-and-forget 钩子（§4 D-4 / §1 DK2）。
// ---------------------------------------------------------------------------
// 背景：持久化件（IndexedDB HistoryDriver / sessions 存储 / hydrate）已齐，但 runtime 里
//   没有落盘调用。本文只做「接线」：把 commands / modelRun 的写事件转成 driver 调用。
//   · DK2 fire-and-forget：写盘绝不卡 UI —— 每个钩子都同步返回 void，内部 `void ...catch(()=>{})`
//     把落盘扔进微任务队列、吞掉任何错误（对齐 driver 自身的 best-effort 降级契约）。
//   · driver 注入（兼顾可测）：main.tsx 启动时 configurePersistence 注入真 driver 实例；
//     未配置（undefined）时全部 no-op、不抛 —— 因此 commands/modelRun 的既有单测无需配置即保持绿。
//   本文不 import UI，也不持有 store 引用（persistSessions 内部自取 rootStore，对齐 U2）。

import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import type { SessionMeta, WorkspaceMeta } from '../state/core.type'
import type { Checkpoint } from '../state/checkpoint.type'
import type { HistoryDriver } from '../state/persistence/historyDriver'

// 会话列表持久化器的结构（对应 createSessionsPersistence 的返回形状）；接线只用到 saveSessions。
interface SessionsPersistence {
  saveSessions(sessions: SessionMeta[]): Promise<void>
  loadSessions(): Promise<SessionMeta[]>
  saveWorkspaces?(workspaces: WorkspaceMeta[]): Promise<void>
  loadWorkspaces?(): Promise<WorkspaceMeta[]>
}

// ===========================================================================
// 模块级 driver 注入 —— 未配置时全部 no-op
// ===========================================================================

let history: HistoryDriver | undefined
let sessions: SessionsPersistence | undefined
const checkpointWriteTails = new Map<string, Promise<void>>()
let sessionsWriteTail: Promise<void> | undefined
let workspacesWriteTail: Promise<void> | undefined

// 简介：注入/更新持久化 driver（HistoryDriver + 会话列表存储）。
// 详情：浅合并，只覆盖传入的字段；未传的保持原值。main.tsx 用与 hydrate 相同的一对实例注入。
export function configurePersistence(deps: {
  history?: HistoryDriver
  sessions?: SessionsPersistence
}): void {
  if (deps.history !== undefined) history = deps.history
  if (deps.sessions !== undefined) sessions = deps.sessions
}

// 简介：复位注入（仅测试用）——把两个 driver 置回 undefined，隔离用例之间的模块级状态。
export function resetPersistence(): void {
  history = undefined
  sessions = undefined
  checkpointWriteTails.clear()
  sessionsWriteTail = undefined
  workspacesWriteTail = undefined
}

// ===========================================================================
// fire-and-forget 落盘钩子 —— 未配置全部 no-op、绝不抛（DK2）
// ===========================================================================

// 简介：把当前会话列表覆盖式落盘（会话增删改后调用）。
// 详情：取 rootStore.sessionsAtom 全部 SessionMeta 交给 saveSessions；未配置则 `?.` 短路成 no-op。
export function persistSessions(): void {
  const driver = sessions
  if (!driver) return
  // Capture the snapshot at call time and serialize full-list overwrites. An
  // execution node commonly emits queued → running → terminal within a short
  // interval; letting those writes race can put an older running snapshot back
  // on disk after the terminal one.
  const snapshot = Object.values(rootStore.getter(sessionsAtom))
  const write = sessionsWriteTail
    ? sessionsWriteTail.then(() => driver.saveSessions(snapshot))
    : driver.saveSessions(snapshot)
  const settled = write.catch(() => {})
  sessionsWriteTail = settled
  void settled.finally(() => {
    if (sessionsWriteTail === settled) sessionsWriteTail = undefined
  })
}

// 简介：把一级工作区登记表覆盖式落盘；旧 driver 未实现该方法时安全降级为 no-op。
export function persistWorkspaces(): void {
  const driver = sessions
  if (!driver?.saveWorkspaces) return
  const snapshot = Object.values(rootStore.getter(workspacesAtom))
  const write = workspacesWriteTail
    ? workspacesWriteTail.then(() => driver.saveWorkspaces!(snapshot))
    : driver.saveWorkspaces(snapshot)
  const settled = write.catch(() => {})
  workspacesWriteTail = settled
  void settled.finally(() => {
    if (workspacesWriteTail === settled) workspacesWriteTail = undefined
  })
}

// 简介：把某会话刚提交的一轮 checkpoint 落盘（commitCheckpoint 之后调用）。
export function persistCheckpoint(id: string, checkpoint: Checkpoint): void {
  const driver = history
  if (!driver) return
  const previous = checkpointWriteTails.get(id)
  const write = previous
    ? previous.then(() => driver.saveCheckpoint(id, checkpoint))
    : driver.saveCheckpoint(id, checkpoint)
  const settled = write.catch(() => {})
  checkpointWriteTails.set(id, settled)
  void settled.finally(() => {
    if (checkpointWriteTails.get(id) === settled) checkpointWriteTails.delete(id)
  })
}

// 简介：截断某会话中 turnIndex 之后的持久化 checkpoint（回退 jumpToCheckpoint 之后调用）。
export function persistTruncate(id: string, turnIndex: number): void {
  void history?.truncateAfter(id, turnIndex).catch(() => {})
}

// 简介：清空某会话的全部持久化历史（removeSession 之后调用）。
export function persistDeleteSession(id: string): void {
  void history?.deleteSession(id).catch(() => {})
}
