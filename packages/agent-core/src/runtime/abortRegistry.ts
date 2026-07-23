// 每会话一个 AbortController 的注册表（非 atom）。
// 职责：让「起 run / 中断 run / run 结束清理」对齐同一个 AbortController，
// 保证 esc 能断当前 run，且新 run 会顶掉旧 run，旧 run 的清理不误删新 run。
//
// 【实例化 · 第 1 期】本文件改成 defaultCore 的【视图】：controllers Map 从模块级搬进了
//   CoreInstance（defaultCore.abort），这里的五个导出只是【委托】给 defaultCore.abort 的同名方法。
//   签名一字不变，故 `import { beginRun, endRun } from './abortRegistry'` 等调用点一行不用改。

import { defaultCore } from './core/coreInstance'

// 起一个 run：若该 id 已有 controller，先 abort 旧的（新 run 顶掉旧 run），
// 再登记全新 controller，返回其 signal 供 model 调用穿透。
export function beginRun(id: string): AbortSignal {
  return defaultCore.abort.beginRun(id)
}

// 中断该 id 正在跑的 run：abort 并从 Map 删除；无则 no-op。
export function abortRun(id: string): void {
  defaultCore.abort.abortRun(id)
}

// run 结束清理：仅当 Map 里该 id 当前 controller 的 signal 就是传入 signal 时才 delete，
// 避免被顶掉的旧 run（signal 已换）在 finally 里清掉新 run 的 controller。
export function endRun(id: string, signal: AbortSignal): void {
  defaultCore.abort.endRun(id, signal)
}

// 该 id 是否有登记中的 run。
export function isRunning(id: string): boolean {
  return defaultCore.abort.isRunning(id)
}

// 仅测试用：清空注册表，保证在用例间互不污染。
export function resetAbortRegistry(): void {
  defaultCore.abort.reset()
}
