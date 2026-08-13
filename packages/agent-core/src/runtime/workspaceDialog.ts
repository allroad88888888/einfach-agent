import { open } from '@tauri-apps/plugin-dialog'
import { isTauriHost } from './hostTauri'

export type PickWorkspaceDirectoryResult =
  | { ok: true; path?: string }
  | { ok: false; error: string }

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
