// 目录选择器的宿主桥（D3）。范式照抄同目录的 hostTauri.ts：`@tauri-apps/plugin-dialog` 只能
// 惰性加载——静态 import 会在各测试文件的 vi.mock 生效前把真模块灌进 worker 模块图，令同名 mock
// 全部失效（S2c 3911c9d 的教训）；改惰性后本文件不再是 core 模块图里的 @tauri-apps 静态边。
//
// `@tauri-apps/plugin-dialog` 在本文件里只有一处运行时边（下方 loadDialogModule 里的动态 import）；
// 其余 `typeof import(...)` 都是类型位置引用，编译期擦除、不产生运行时依赖。
import { isTauriHost } from './hostTauri'

export type PickWorkspaceDirectoryResult =
  | { ok: true; path?: string }
  | { ok: false; error: string }

// module promise 必须缓存（`??=`）：同一 tick 内并发发起首次 import 时，Vitest 4 的 mocker 有一路
// 可能拿到未被替换的真模块（记档见 hostTauri.ts 与 state/stateViewPort.ts）；缓存后每个模块实例
// 只发一次 import，解析结果对所有调用点一致。
let dialogModule: Promise<typeof import('@tauri-apps/plugin-dialog')> | undefined

const loadDialogModule = () => (dialogModule ??= import('@tauri-apps/plugin-dialog'))

async function loadDialogOpen(): Promise<typeof import('@tauri-apps/plugin-dialog').open> {
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
    return { ok: false, error: 'Directory picker is only available in the Tauri desktop runtime' }
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
