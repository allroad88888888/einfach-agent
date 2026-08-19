// hostBridge 的共享测试脚手架（转换那一半）。收敛此前散落在各测试文件里手写的宿主桥 mock 工厂：
// `vi.mock('./hostBridge', factory)` 的四个桥测试消费方（workspaceRead.contentHash /
// workspaceRead.runIndexPage、workspaceWrite、workspacePatch、shellCommand.backgroundKill 等）
// 都用下面的 hostBridgeMock，因为它们测的是"拿到 invoke 之后怎么转换参数/结果"，不关心
// hasHostBridge() 这道守卫本身——守卫开关是另一份脚手架，见 ./hostBridge.testHarness.ts 的
// stubHostBridgeFlag。

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
 * 给 `vi.mock('./hostBridge', factory)` 用的共享工厂。形状：hasHostBridge 恒真（这几个桥测试
 * 只关心"已经有桥"这一种场景，测的是"拿到 invoke 之后怎么转换参数/结果"，不测 hasHostBridge()
 * 这道守卫本身），loadHostInvoke 用调用方给的实现——多数消费文件只需要
 * `async () => someInvokeStub`，具体形态由各自的测试自行决定，本函数不钉死。
 *
 * 返回类型用的是 hostBridge.ts 自己导出的 HostInvoke——hostBridge 这条链路的一条纪律
 * （见 hostBridge.ts 文件头注释）是全程不认识任何具体宿主的上游包，这份测试脚手架的类型标注
 * 也不该在这里悄悄把某个宿主的名字带回来。
 *
 * hoisting 限制：本函数必须在 vi.mock 的工厂箭头函数体内被调用——
 * `vi.mock('./hostBridge', () => hostBridgeMock(loadHostInvoke))`——不能在模块顶层先求值结果再传
 * 给 vi.mock（vi.mock 期待的是"工厂函数"本身，而不是工厂函数的返回值）。传入的 loadHostInvoke
 * 参数可以安全引用同文件里 `vi.hoisted()` 声明的变量——那些变量正是为绕开 vi.mock 的 hoisting
 * 限制而生的；不能引用同文件里普通 const/let 声明的模块顶层变量（会在 TDZ 报错，因为 vi.mock
 * 调用本身被 vitest 提升到所有 import/变量声明之前）。本函数是从另一个模块 import 进来的绑定，
 * 不受这条限制。
 */
export function hostBridgeMock(
  loadHostInvoke: () => Promise<HostInvoke>,
): { hasHostBridge: () => boolean; loadHostInvoke: () => Promise<HostInvoke> } {
  return { hasHostBridge: () => true, loadHostInvoke }
}
