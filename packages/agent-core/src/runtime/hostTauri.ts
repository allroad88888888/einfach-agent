// 本机 Tauri 宿主探测 + 惰性 invoke 加载器。D2-D5 会把 13 个文件里静态的
// `import { invoke, isTauri } from '@tauri-apps/api/core'` 陆续换成本文件的两个导出，
// 让 core 的模块图不再无条件绑定 @tauri-apps/api；静态 import 会在各测试文件的 vi.mock
// 生效前把真模块灌进 worker 模块图，令同名 mock 全部失效（S2c 3911c9d 的教训，
// state/stateViewPort.ts 第 16-22 行同款记档）。本文件是这两处收口，后续四张卡照抄这个范式。
//
// `@tauri-apps` 在本文件里只有一处运行时边（下方 loadTauriCore 里的动态 import）。D9 之前，
// 下面出现的 `typeof import(...)` 曾被当成"类型位置引用，编译期擦除、不产生运行时依赖"而放行——
// 但 optional peer 缺席（未装 @tauri-apps/api）时，这类引用会原样进 `loadTauriInvoke` 的导出
// 签名，让 `packages/agent-core/dist/runtime/hostTauri.d.ts` 里残留 `typeof import('@tauri-apps/…')`，
// 消费方 tsc 解析不到该模块（运行时无碍，但发布物的类型面不自洁）。D9 起改用下方 TauriInvokeFn
// 这个本地结构类型，连类型位置的 `@tauri-apps` 引用也一并清零。

// isTauriHost()：逐字对齐 @tauri-apps/api 2.11.1 的 isTauri() 实现
// （node_modules/@tauri-apps/api/core.js:278-281）：
//   function isTauri() {
//     return !!(globalThis || window).isTauri;
//   }
// 纯全局量读取，零运行时依赖——不 import @tauri-apps/api 本身就能判断是否跑在 Tauri webview 里。
// 保留 `globalThis || window` 的取值顺序与外层 `!!`：globalThis 恒真，所以 window 分支实际从不
// 求值，但这正是要对齐的上游行为，不是可以化简掉的冗余；`as { isTauri?: boolean }` 只是给这次
// 全局量读取一个最小类型，等价于上游用 `any` 做的 unsafe member access。
export function isTauriHost(): boolean {
  return !!((globalThis || window) as { isTauri?: boolean }).isTauri
}

/**
 * 上游 Tauri core 模块 `invoke` 的本地结构类型。真实签名（该模块的 core.d.ts）是
 * `invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T>`，
 * 其中 `InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array`。
 * 本包内全部调用点（workspaceRead/Write/Delete/Patch/PathOperation/Rg/Task、
 * shellCommand、workspaceChange、workspaceGit）只传 `cmd` + 一个 `Record<string, unknown>`
 * 形态的 `args`，从不传第三个 `options` 参数，因此本地类型按"调用点实际用到的形状"收窄到
 * 两个参数——泛型形态必须保留：调用方全部写成 `invoke<unknown>(...)` 带类型实参调用，
 * 非泛型的本地类型会让它们全体报错。
 * 收窄后仍能装下真实 invoke：函数参数按逆变检查，`Record<string, unknown>` 是
 * `InvokeArgs` 联合的一支，真实签名结构上兼容这个更窄的本地类型，无需运行时转换或类型断言。
 *
 * 本注释故意不写出上游包名的字面量：这段 JSDoc 挂在导出类型上，tsc 出 d.ts 时会原样带走注释，
 * 写出包名字面量会让发布物 d.ts 重新出现该字符串，即便运行时/类型都已不依赖它（D9 判据要求
 * `packages/agent-core/dist` 的 `.d.ts` 里这段字符串零命中）。
 */
export type TauriInvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

// loadTauriInvoke()：惰性加载 `@tauri-apps/api/core` 的 invoke。
// module promise 必须缓存（`??=`）：同一 tick 内并发发起首次 import 时，Vitest 4 的 mocker
// 有一路可能拿到未被替换的真模块（实测 SubagentTreePanel 的 run 索引与 candidate skills 两条
// effect 同时触发时命中，见 state/stateViewPort.ts 同款记档）；缓存后每个模块实例只发一次
// import，解析结果对所有调用点一致。
//
// `tauriCoreModule` 的类型故意只写 `{ invoke: TauriInvokeFn }`（用得到的那一个成员），
// 不写 `typeof import('@tauri-apps/api/core')`（模块全量命名空间类型）——这个变量虽然不导出、
// 不会进 d.ts，但 D9 判据要求 src 里除动态 import() 行与说明注释外，类型位置的 `@tauri-apps`
// 引用清零，这里跟着改是为了满足这条门槛，不是因为它本身会泄漏。
let tauriCoreModule: Promise<{ invoke: TauriInvokeFn }> | undefined

const loadTauriCore = () => (tauriCoreModule ??= import('@tauri-apps/api/core'))

export async function loadTauriInvoke(): Promise<TauriInvokeFn> {
  return (await loadTauriCore()).invoke
}
