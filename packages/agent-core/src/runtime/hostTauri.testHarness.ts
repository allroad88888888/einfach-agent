// hostBridge 的共享测试脚手架。收敛此前散落在各测试文件里手写的宿主桥 mock 工厂：
// `vi.mock('./hostBridge', factory)` 的四个桥测试消费方（workspaceRead.contentHash /
// workspaceRead.runIndexPage、workspaceWrite、workspacePatch、shellCommand.backgroundKill 等）
// 都用下面的 hostBridgeMock，因为它们测的是"拿到 invoke 之后怎么转换参数/结果"，不关心
// hasHostBridge() 这道守卫本身——守卫开关是另一份脚手架，见 ./hostBridge.testHarness.ts 的
// stubHostBridgeFlag。
//
// 不在这里处理的东西：apps/web/src/mcp/** 里 vi.mock('@tauri-apps/api/core') 的 invoke/isTauri
// 分量——那些文件的生产源码仍直接 `import { isTauri } from '@tauri-apps/api/core'`，没有迁到
// isTauriHost()，两层 mock 各管各的，不属于本卡改动面。
//
// H6 清理记录：本文件曾并存两套工厂——hostTauriBridgeMock（配 vi.mock('./hostTauri')，服务尚未把
// 生产源码从 isTauriHost()/loadTauriInvoke() 切到 hasHostBridge()/loadHostInvoke() 的桥测试）与
// stubTauriHostFlag（直接切 globalThis.isTauri，配 isTauriHost() 判据本身的开关）。前者随
// H2/H3/H4 把四个桥测试全部迁到 vi.mock('./hostBridge') 后失去消费方；后者随「工具可见性总闸」等
// 判据从 isTauriHost() 换成 hasHostBridge()（迁移过程见 hostBridge.testHarness.ts 里
// stubHostBridgeFlag 的说明——那段明确写了"继续用 stubTauriHostFlag 会静默测错场景，所以调用点
// 一律换成 stubHostBridgeFlag"）也失去消费方——两者在本卡一并删除，仓库里彼时只剩同文件内注释
// 提及它们的名字，没有真实调用点。isTauriHost() 目前仍有一个生产消费方 workspaceDialog.ts（未决
// 项，判据尚未切换到 hasHostBridge()，见该文件），但它从未有专属测试用过 stubTauriHostFlag：
// index.smoke.test.ts 对 pickWorkspaceDirectory() 的 Tauri 分支走的是自包含的 globalThis.isTauri
// 存取（手法见该文件顶部），本就没有接这份 harness。将来若 workspaceDialog.ts 需要更细的专属
// 测试，沿用 index.smoke.test.ts 那套自包含写法即可；等真的冒出多个消费方，再重新抽一个共享
// helper 也不迟。

import type { HostInvoke } from './hostBridge'

// 「当前宿主有没有本机能力」的开关（H4b 的 stubHostBridgeFlag）**不在本文件**，住
// hostBridge.testHarness.ts。原因是硬的、不是风格问题：那个 helper 必须真的调用
// configureHostInvoke，也就是要对 './hostBridge' 做一次**值导入**；而本文件被
// workspaceRead/workspaceWrite/workspacePatch/shellCommand 四个桥测试 import，它们又都
// `vi.mock('./hostBridge', () => hostBridgeMock(...))`。vi.mock 被提升到所有 import 之前，
// 于是本文件顶层的那次值导入会撞进被 mock 模块的 TDZ，四个文件全部报
// 「Cannot access '__vi_import_0__' before initialization」（实测）。本文件对 './hostBridge'
// 只能保持 `import type`——类型在编译期擦除，不产生运行时导入。

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
