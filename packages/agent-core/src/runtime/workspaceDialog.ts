// 目录选择器的宿主桥（D3）。范式照抄同目录的 hostTauri.ts：`@tauri-apps/plugin-dialog` 只能
// 惰性加载——静态 import 会在各测试文件的 vi.mock 生效前把真模块灌进 worker 模块图，令同名 mock
// 全部失效（S2c 3911c9d 的教训）；改惰性后本文件不再是 core 模块图里的 @tauri-apps 静态边。
//
// `@tauri-apps/plugin-dialog` 在本文件里只有一处运行时边（下方 loadDialogModule 里的动态 import）。
// D9 之前，其余 `typeof import(...)` 被当成"类型位置引用，编译期擦除"而放行；但 optional peer
// 缺席时这类引用会原样进 d.ts（core 侧的 hostTauri.d.ts 实测命中，本文件的 `open`/`loadDialogOpen`
// 因未导出实测未泄漏，但同样清零以满足 D9 判据）。D9 起改用下方 TauriOpenDialogFn 本地结构类型，
// 类型位置的 `@tauri-apps` 引用一并清零。
import { isTauriHost } from './hostTauri'

export type PickWorkspaceDirectoryResult =
  | { ok: true; path?: string }
  | { ok: false; error: string }

/**
 * 上游 Tauri dialog 插件 `open()` 选项面的本地结构类型——只写下方 pickWorkspaceDirectory
 * 实际传的字段（title/directory/multiple/recursive/canCreateDirectories/defaultPath），不含真实
 * `OpenDialogOptions` 里未用到的 filters/pickerMode/fileAccessMode 等字段。
 *
 * 本注释故意不写出上游包名的字面量：这段 JSDoc 挂在导出类型上，tsc 出 d.ts 时会原样带走注释，
 * 写出包名字面量会让发布物 d.ts 重新出现该字符串，即便运行时/类型都已不依赖它（D9 判据要求
 * `packages/agent-core/dist` 的 `.d.ts` 里这段字符串零命中）。
 */
export interface TauriOpenDialogOptions {
  title?: string
  directory?: boolean
  multiple?: boolean
  recursive?: boolean
  canCreateDirectories?: boolean
  defaultPath?: string
}

/**
 * `open()` 的本地结构类型。真实签名是条件类型
 * `open<T extends OpenDialogOptions>(options?: T): Promise<OpenDialogReturn<T>>`，
 * 其中 `OpenDialogReturn<T>` 无论 `directory`/`multiple` 取值如何，落点都在
 * `string[] | null` 或 `string | null` 两支之一，因此本地类型按下方调用点的真实用法
 * 收窄为非泛型签名，返回 `Promise<string | string[] | null>`。
 */
export type TauriOpenDialogFn = (options?: TauriOpenDialogOptions) => Promise<string | string[] | null>

// module promise 必须缓存（`??=`）：同一 tick 内并发发起首次 import 时，Vitest 4 的 mocker 有一路
// 可能拿到未被替换的真模块（记档见 hostTauri.ts 与 state/stateViewPort.ts）；缓存后每个模块实例
// 只发一次 import，解析结果对所有调用点一致。
//
// `dialogModule` 的类型故意只写 `{ open: TauriOpenDialogFn }`（用得到的那一个成员），理由同
// hostTauri.ts 的 tauriCoreModule：这个变量不导出、不会进 d.ts，跟着改类型是为了满足 D9 判据
// "类型位置 @tauri-apps 引用清零"，不是因为它本身会泄漏。
let dialogModule: Promise<{ open: TauriOpenDialogFn }> | undefined

const loadDialogModule = () => (dialogModule ??= import('@tauri-apps/plugin-dialog'))

async function loadDialogOpen(): Promise<TauriOpenDialogFn> {
  return (await loadDialogModule()).open
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function canPickWorkspaceDirectory(): boolean {
  return isTauriHost()
}

export async function pickWorkspaceDirectory(defaultPath?: string): Promise<PickWorkspaceDirectoryResult> {
  if (!isTauriHost()) {
    return { ok: false, error: '选择 workspace 目录：当前宿主未提供命令桥' }
  }

  try {
    // 加载点在 isTauriHost() 守卫之后：非 Tauri 宿主永远不会把 plugin-dialog 拉进模块图。
    const open = await loadDialogOpen()
    const selected = await open({
      title: '选择工作目录',
      directory: true,
      multiple: false,
      recursive: true,
      canCreateDirectories: false,
      defaultPath: defaultPath?.trim() || undefined,
    })

    if (!selected) return { ok: true }
    if (Array.isArray(selected)) {
      const [first] = selected.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      return { ok: true, path: first }
    }
    return { ok: true, path: selected }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
