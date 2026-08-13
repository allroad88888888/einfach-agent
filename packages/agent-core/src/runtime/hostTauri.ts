// 本机 Tauri 宿主探测 + 惰性 invoke 加载器。D2-D5 会把 13 个文件里静态的
// `import { invoke, isTauri } from '@tauri-apps/api/core'` 陆续换成本文件的两个导出，
// 让 core 的模块图不再无条件绑定 @tauri-apps/api；静态 import 会在各测试文件的 vi.mock
// 生效前把真模块灌进 worker 模块图，令同名 mock 全部失效（S2c 3911c9d 的教训，
// state/stateViewPort.ts 第 16-22 行同款记档）。本文件是这两处收口，后续四张卡照抄这个范式。
//
// `@tauri-apps` 在本文件里只有一处运行时边（下方 loadTauriCore 里的动态 import）；下面出现的
// `typeof import(...)` 都是类型位置引用，编译期擦除、不产生运行时依赖，因此不计入这条红线。

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

// loadTauriInvoke()：惰性加载 `@tauri-apps/api/core` 的 invoke。
// module promise 必须缓存（`??=`）：同一 tick 内并发发起首次 import 时，Vitest 4 的 mocker
// 有一路可能拿到未被替换的真模块（实测 SubagentTreePanel 的 run 索引与 candidate skills 两条
// effect 同时触发时命中，见 state/stateViewPort.ts 同款记档）；缓存后每个模块实例只发一次
// import，解析结果对所有调用点一致。
let tauriCoreModule: Promise<typeof import('@tauri-apps/api/core')> | undefined

const loadTauriCore = () => (tauriCoreModule ??= import('@tauri-apps/api/core'))

export async function loadTauriInvoke(): Promise<typeof import('@tauri-apps/api/core').invoke> {
  return (await loadTauriCore()).invoke
}
