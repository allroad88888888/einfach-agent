// 宿主进程退出时的兜底：不让任何 MCP 子进程活过它的父亲
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/mcp_manager.rs 的 `impl Drop for McpManagerInner`（应用退出时 Tauri 的
// managed state 被 drop，逐个 close 会话）。Node 没有析构，只有 `process.on('exit')`。
//
// ═══ 为什么这道网是必需的 ═══
// 子进程被有意放进**自己的进程组**（见 childProcess.ts），代价是它不会跟着父进程一起死。
// 一个没被杀干净的 MCP server 会**一直挂在用户机器上**，而症状（几天后一堆僵尸进程、端口被占、
// 风扇狂转）离病因十万八千里，谁也不会想到是几天前关掉的那个 agent。
//
// ═══ 这道网覆盖到哪、覆盖不到哪（已实测，不是推测）═══
//   覆盖：正常退出（event loop 空）、`process.exit()`、未捕获异常。
//   **不覆盖：SIGTERM / SIGINT / SIGKILL。** 实测过：Node 对没有 listener 的 SIGTERM 走默认
//   处置直接终止，`'exit'` 回调**不会执行**，子进程活下来。
//
// 不在本包里装信号处理器，是一个有理由的取舍而不是遗漏：
//   · 装 SIGINT 处理器会**改掉宿主的语义**——CLI 的 REPL 用 Ctrl-C 中断当前轮次而不是退出，
//     本包一旦挂上 listener，Node 就不再走默认终止，而我们又无从判断这次 Ctrl-C 是哪个意思。
//   · 装 SIGTERM 处理器的副作用小得多，但它仍是「能力包偷偷改进程级行为」，而这类隐式全局
//     正是本仓库反复吃过亏的形态。
// 所以信号归宿主装配层：它知道自己是 CLI 还是 server，也知道 Ctrl-C 该是什么意思。
// **需要的接口已经在 index.ts 的 `createMcpRoutes` 里留好了**（`registerHostDisposer`），
// 装配层把 dispose 挂到自己的信号处理里即可。

import type { ChildProcess } from 'node:child_process'
import { killChildGroup } from './childProcess'

const trackedChildren = new Set<ChildProcess>()
let listenerInstalled = false

/**
 * 退出回调**必须是同步的**：`'exit'` 之后 event loop 不再转，任何 await / setTimeout 都不会
 * 执行。`process.kill` 是同步系统调用，正好够用。
 */
function killTrackedChildren(): void {
  for (const child of trackedChildren) {
    try {
      killChildGroup(child)
    } catch {
      // 已经死了、或权限没了。下一个。
    }
  }
  trackedChildren.clear()
}

/**
 * 把一个子进程纳入退出兜底，返回摘除函数（会话正常关闭时调用）。
 *
 * listener 是**按需装、用完摘**的：`createMcpRoutes` 在测试里会被调很多次，无条件装会攒出
 * 一堆同样的 listener 并触发 MaxListenersExceededWarning——那条警告本身无害，但它会把
 * 「真的漏了 listener」这类信号淹掉。
 */
export function trackChildForHostExit(child: ChildProcess): () => void {
  trackedChildren.add(child)
  if (!listenerInstalled) {
    listenerInstalled = true
    process.on('exit', killTrackedChildren)
  }
  return () => {
    trackedChildren.delete(child)
    if (trackedChildren.size === 0 && listenerInstalled) {
      listenerInstalled = false
      process.removeListener('exit', killTrackedChildren)
    }
  }
}

/** 当前被兜底的子进程数。仅供测试断言「会话关掉之后确实摘干净了」。 */
export function trackedChildCount(): number {
  return trackedChildren.size
}
