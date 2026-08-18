// hostBridge 的「守卫开关」测试脚手架（H4b）：只回答 `hasHostBridge()` 该答 true 还是 false。
//
// 【为什么单独一个文件，而不是并进 hostTauri.testHarness.ts】
// 那个文件被 workspaceRead / workspaceWrite / workspacePatch / shellCommand 四个桥测试 import
// （它们要那里的 hostBridgeMock），而这四个文件又都 `vi.mock('./hostBridge', factory)`。
// vitest 把 vi.mock 提升到所有 import 之前，所以任何被它们 import 的模块只要对 './hostBridge'
// 做**值导入**，就会撞进被 mock 模块的 TDZ，四个文件一起报
// 「Cannot access '__vi_import_0__' before initialization」（实测，不是推测）。
// 本文件必须真的调用 configureHostInvoke（值导入），因此只能与那份脚手架分家：谁需要开关就
// import 本文件，谁需要 mock 就 import 那边的工厂，两条通路永不在同一个模块图上相遇。
//
// 【与 hostBridgeMock 的分工，别混用】
//   · 本文件管**守卫**：用真实的 hostBridge 模块，不 mock，只登记/清空 loader，让
//     `hasHostBridge()` 答 true/false。给「宿主有没有本机能力」这个判断本身做桩。
//   · hostBridgeMock（hostTauri.testHarness.ts）管**转换**：整体 mock 掉 hostBridge，喂一个能
//     返回数据的 invoke，给「拿到 invoke 之后怎么转参数/结果」的桥测试用。

import { configureHostInvoke, type HostInvoke } from './hostBridge'

/**
 * 登记（enabled=true）或清空（false）一个桩 host bridge，等价于切换「当前宿主有没有本机能力」。
 *
 * 【为什么需要它 / 它取代了谁】工具可见性总闸（turnToolVisibility.ts 的 isToolVisible）的源头
 * 已从 `isTauriHost()` 改判为 `hasHostBridge()`，切 `globalThis.isTauri` 对它**再无影响**。
 * 依赖「server 工具对模型可见」的测试若继续用 stubTauriHostFlag，用例仍会跑、多数断言仍会过，
 * 但测的已经是「在没有本机能力的宿主上跑」——静默失准比失败更危险，所以那些调用点一律换成本函数。
 *
 * 【桩 invoke 为什么必定 reject】这些用例要的只是「宿主声称有本机能力，于是 server 工具可见、
 * 可被加载和调用」，命令本身跑不跑得通不在它们的断言里。reject 同时也是改动前的真实表现：
 * 那时 `loadTauriInvoke()` 动态 import 上游模块拿到真 invoke，而 jsdom 里没有宿主内部通道，
 * 一调用就抛；工具侧一律 catch 成失败结果。保持 reject，用例的可观察行为逐条不变。
 * 需要 invoke 真的返回数据的测试不该用本函数，用 hostBridgeMock。
 *
 * 【必须复位】loader 是 hostBridge 的模块级状态，会泄漏到同文件的后续用例，调用方要挂
 * `afterEach(() => stubHostBridgeFlag(false))`。
 */
export function stubHostBridgeFlag(enabled: boolean): void {
  if (!enabled) {
    configureHostInvoke(undefined)
    return
  }
  const unavailableInvoke: HostInvoke = (cmd) =>
    Promise.reject(new Error(`host bridge stub: ${cmd} is not implemented in this test`))
  configureHostInvoke(() => Promise.resolve(unavailableInvoke))
}
