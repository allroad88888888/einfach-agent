// 工作区目录选择的宿主中立门面。
// ---------------------------------------------------------------------------
// 浏览器没有把目录选择结果变成真实绝对路径的标准 API；这件事必须交给已登记的本机宿主桥。
// 本文件只负责「有桥才调用」与收窄返回值，不认识 Node、Tauri 或任一操作系统。

import { hasHostBridge, loadHostInvoke } from './hostBridge'

export type PickWorkspaceDirectoryResult =
  | { ok: true; path?: string }
  | { ok: false; error: string }

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return typeof error === 'string' ? error : '无法打开系统文件夹选择器。'
}

function readPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const path = (value as { path?: unknown }).path
  return typeof path === 'string' && path.trim() ? path : undefined
}

/** True only when the current host can receive a native directory-picker request. */
export function canPickWorkspaceDirectory(): boolean {
  return hasHostBridge()
}

/** Opens the host directory picker; cancelling deliberately leaves the workspace unchanged. */
export async function pickWorkspaceDirectory(): Promise<PickWorkspaceDirectoryResult> {
  if (!hasHostBridge()) return { ok: false, error: '当前宿主不支持选择本机文件夹。' }

  try {
    const invoke = await loadHostInvoke()
    const path = readPath(await invoke<unknown>('pick_workspace_directory'))
    return path ? { ok: true, path } : { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}
