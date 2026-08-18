// hostTauri 的共享测试脚手架（D8）。收敛此前散落在各测试文件里手写的两种 Tauri 宿主模拟：
//   1. 直接切 globalThis.isTauri（isTauriHost() 的真实读取目标）——modelRun 系、
//      apps/web/src/plugins/initialize.test.ts 用它模拟"当前是不是 Tauri 宿主"。
//   2. 整体 vi.mock('./hostTauri')，连 loadTauriInvoke 一起换掉——workspaceRead/workspaceWrite/
//      shellCommand 的桥测试用它，因为这些文件测的是"拿到 invoke 之后怎么转换参数/结果"，不关心
//      isTauriHost() 本身。
// index.smoke.test.ts 与 hostTauri.test.ts 的探针写法保留自包含，不接本文件——它们验证的是
// hostTauri.ts 本体或模块图加载时机，混进共享 helper 反而模糊了"探针独立可信"这层价值。
//
// 不在这里处理的东西：apps/web/src/mcp/** 里 vi.mock('@tauri-apps/api/core') 的 invoke/isTauri
// 分量——那些文件的生产源码仍直接 `import { isTauri } from '@tauri-apps/api/core'`，没有迁到
// isTauriHost()，两层 mock 各管各的，不属于本卡改动面。
//
// H1b 追加：hostBridge（新宿主注入点，见 ./hostBridge.ts）的同形工厂 hostBridgeMock。
// workspaceRead.contentHash / workspaceRead.runIndexPage（H2）、workspaceWrite（H3）、
// shellCommand.backgroundKill（H4）四个桥测试目前都 vi.mock('./hostTauri')；随各自那张卡把生产
// 源码从 isTauriHost()/loadTauriInvoke() 切到 hasHostBridge()/loadHostInvoke() 后，测试也要跟着
// 改成 vi.mock('./hostBridge')。三张卡若各自在自己的测试文件里新写一份工厂，会同时改这一个共享
// 文件、互相冲突，所以本卡（H1b）先把工厂摘出来，四个消费方各自逐卡切换即可。旧的
// hostTauriBridgeMock 原样保留、不删：切换期间两条通路并存（还没切的文件继续 mock ./hostTauri，
// 切过的文件改 mock ./hostBridge），等 H2/H3/H4 全部切完、仓库里不再有人 import
// hostTauriBridgeMock，才由 H6 一并删除旧工厂（连同上面第 2 条说明）。

import type { HostInvoke } from './hostBridge'

/** globalThis 上 isTauri 属性的最小类型——逐字对齐 hostTauri.ts 自己的写法。 */
type GlobalWithIsTauri = typeof globalThis & { isTauri?: boolean }
const globalWithIsTauri = globalThis as GlobalWithIsTauri

/**
 * 把 globalThis.isTauri 设为 enabled，返回一个 restore()：调用后把它还原到"这次 stub 之前"
 * 的状态——原本没有该属性就 delete 掉，原本有值（含显式 undefined 的自有属性）就恢复原值，
 * 不是硬编码恢复成 false。descriptor 判定手法照抄 hostTauri.test.ts / index.smoke.test.ts 的范式。
 *
 * 一个函数伺候两种既有写法，靠的是"要不要接住返回值"：
 *   - 用例内切换、结束统一复位到固定值（modelRun 系）：直接在 beforeEach/it 里调用
 *     `stubTauriHostFlag(true)`，丢弃返回值；文件自己已有的顶层 `afterEach(() => {
 *     stubTauriHostFlag(false) })` 负责收尾，不需要"恢复到调用前状态"这层语义。
 *   - 运行期才知道要 stub 成什么值，且要求恢复到 stub 之前的状态（initialize.test.ts 的
 *     freshHost(tauriHost) 按参数切换）：用一个模块级可变引用接住 restore()，配合模块顶层
 *     （收集阶段）注册的一个静态 `afterEach(() => restore())`——afterEach 本身必须在收集阶段
 *     注册，不能等运行期才决定要不要挂，所以这层"挂钩子"的活留给调用方，本函数只管
 *     "给一个能在任意时刻调用的 restore"。
 */
export function stubTauriHostFlag(enabled: boolean): () => void {
  const hadProperty = Object.prototype.hasOwnProperty.call(globalThis, 'isTauri')
  const originalValue = globalWithIsTauri.isTauri
  globalWithIsTauri.isTauri = enabled
  return () => {
    if (hadProperty) globalWithIsTauri.isTauri = originalValue
    else delete globalWithIsTauri.isTauri
  }
}

/** loadTauriInvoke() 的返回类型——逐字对齐 hostTauri.ts 的签名，避免每个桥测试文件各写一份。 */
type TauriInvoke = typeof import('@tauri-apps/api/core').invoke

/**
 * 给 `vi.mock('./hostTauri', factory)` 用的共享工厂：isTauriHost 恒真（这几个桥测试只关心
 * "已经在 Tauri 里"这一种场景），loadTauriInvoke 用调用方给的实现——多数文件只需要
 * `async () => tauri.invoke`，workspaceWrite 还要在其中推进一个虚拟时钟模拟加载耗时，
 * 因此这里不钉死实现，只统一 isTauriHost 恒真这一半 + 返回值类型。
 *
 * hoisting 限制：本函数必须在 vi.mock 的工厂箭头函数体内被调用——
 * `vi.mock('./hostTauri', () => hostTauriBridgeMock(loadTauriInvoke))`——不能在模块顶层先求值
 * 结果再传给 vi.mock（vi.mock 期待的是"工厂函数"本身，而不是工厂函数的返回值）。传入的
 * loadTauriInvoke 参数可以安全引用同文件里 `vi.hoisted()` 声明的变量（如 `tauri.invoke`）——
 * 那些变量正是为绕开 vi.mock 的 hoisting 限制而生的；不能引用同文件里普通 const/let 声明的
 * 模块顶层变量（会在 TDZ 报错，因为 vi.mock 调用本身被 vitest 提升到所有 import/变量声明之前）。
 * 本函数是从另一个模块 import 进来的绑定，不受这条限制——已在 workspaceRead.contentHash.test.ts
 * 验证过这个形态可行，其余三个桥测试文件照抄。
 */
export function hostTauriBridgeMock(
  loadTauriInvoke: () => Promise<TauriInvoke>,
): { isTauriHost: () => boolean; loadTauriInvoke: () => Promise<TauriInvoke> } {
  return { isTauriHost: () => true, loadTauriInvoke }
}

/**
 * 给 `vi.mock('./hostBridge', factory)` 用的共享工厂——hostTauriBridgeMock 的 hostBridge 版，
 * 形状严格对称：hasHostBridge 恒真（这几个桥测试只关心"已经有桥"这一种场景，测的是"拿到 invoke
 * 之后怎么转换参数/结果"，不测 hasHostBridge() 这道守卫本身），loadHostInvoke 用调用方给的实现——
 * 多数消费文件只需要 `async () => someInvokeStub`，具体形态由各自的测试自行决定，本函数不钉死。
 *
 * 返回类型用的是 hostBridge.ts 自己导出的 HostInvoke，**不是** `hostTauriBridgeMock` 那样借用
 * `typeof import('@tauri-apps/api/core').invoke`——hostBridge 这条链路的一条纪律（见 hostBridge.ts
 * 文件头注释）是全程不出现桌面那个上游包的名字，hostBridge.ts 本体已经不 import 它，这份测试脚手架
 * 的类型标注也不该在这里悄悄把名字带回来。
 *
 * hoisting 限制与 hostTauriBridgeMock 完全一致（同一条 vitest 限制压在两个工厂身上，不是巧合）：
 * 本函数必须在 vi.mock 的工厂箭头函数体内被调用——
 * `vi.mock('./hostBridge', () => hostBridgeMock(loadHostInvoke))`——不能在模块顶层先求值结果再传
 * 给 vi.mock（vi.mock 期待的是"工厂函数"本身，而不是工厂函数的返回值）。传入的 loadHostInvoke
 * 参数可以安全引用同文件里 `vi.hoisted()` 声明的变量——那些变量正是为绕开 vi.mock 的 hoisting
 * 限制而生的；不能引用同文件里普通 const/let 声明的模块顶层变量（会在 TDZ 报错，因为 vi.mock
 * 调用本身被 vitest 提升到所有 import/变量声明之前）。本函数是从另一个模块 import 进来的绑定，
 * 不受这条限制——hostTauriBridgeMock 已经在 workspaceRead.contentHash.test.ts 验证过这个形态可行，
 * H2/H3/H4 切换到 hostBridge 版时可以照抄同一模式。
 */
export function hostBridgeMock(
  loadHostInvoke: () => Promise<HostInvoke>,
): { hasHostBridge: () => boolean; loadHostInvoke: () => Promise<HostInvoke> } {
  return { hasHostBridge: () => true, loadHostInvoke }
}
