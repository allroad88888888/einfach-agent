// 包管理器探测：先看 lockfile，再看 package.json 的 `packageManager` 字段，最后落 npm
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_task.rs 的 `detect_package_manager` 一族。
// 顺序是短路的（先赢先得），逐条对齐 Rust 的 `.or_else(...).unwrap_or(Npm)`：
//   1. lockfile 存在与否——pnpm-lock.yaml / yarn.lock / bun.lock(b) / package-lock.json
//      或 npm-shrinkwrap.json，按这个顺序探测；
//   2. package.json 的 `packageManager` 字段（形如 `"pnpm@8.6.0"`，也接受不带版本号的纯名字）；
//   3. 都探测不到 → 默认 npm。

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function detectFromLockfile(root: string): Promise<PackageManager | undefined> {
  if (await isFile(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await isFile(join(root, 'yarn.lock'))) return 'yarn'
  if ((await isFile(join(root, 'bun.lock'))) || (await isFile(join(root, 'bun.lockb')))) return 'bun'
  if ((await isFile(join(root, 'package-lock.json'))) || (await isFile(join(root, 'npm-shrinkwrap.json')))) {
    return 'npm'
  }
  return undefined
}

function detectFromPackageJson(packageJson: unknown): PackageManager | undefined {
  if (!isRecord(packageJson)) return undefined
  const raw = packageJson.packageManager
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === 'pnpm' || value.startsWith('pnpm@')) return 'pnpm'
  if (value === 'yarn' || value.startsWith('yarn@')) return 'yarn'
  if (value === 'bun' || value.startsWith('bun@')) return 'bun'
  if (value === 'npm' || value.startsWith('npm@')) return 'npm'
  return undefined
}

/** `packageJson` 是 `JSON.parse` 的原始结果（未收窄，由本函数自己收窄）。 */
export async function detectPackageManager(root: string, packageJson: unknown): Promise<PackageManager> {
  return (await detectFromLockfile(root)) ?? detectFromPackageJson(packageJson) ?? 'npm'
}
