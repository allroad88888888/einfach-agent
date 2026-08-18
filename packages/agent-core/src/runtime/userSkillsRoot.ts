// runtime/userSkillsRoot.ts —— 用户级 skills 的扫描根（主目录）解析
// ---------------------------------------------------------------------------
// 工作区级 skills 的根由会话自带；用户级的那份要问宿主要主目录。Tauri 走 path 模块的
// homeDir()，非 Tauri（浏览器）没有文件系统 → undefined，扫描方据此只扫工作区。
// CLI 宿主不走这里：它有 node:os，自己在装配层传 homedir()。
//
// 拿不到主目录一律降级成 undefined 而非抛出：用户级 skills 是增益，主目录解析失败不该让
// 整个项目 skills 扫描（进而 sessionStart 的 skill_manifest）跟着失败。

import { isTauriHost, loadTauriHomeDir } from './hostTauri'

/** 去掉结尾斜杠（保留根 `/`）：homeDir 在不同 Tauri 版本上带不带尾斜杠不一致，而这个值会被
 *  当成路径拼接的根与快照里的展示值，两种写法会让缓存键与 UI 文案随版本漂移。 */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

/**
 * 解析用户级 skills 的扫描根。
 *
 * 返回 undefined = 本宿主没有主目录可扫（浏览器），不是错误。
 */
export async function resolveUserSkillsRoot(): Promise<string | undefined> {
  if (!isTauriHost()) return undefined

  try {
    const homeDir = await loadTauriHomeDir()
    const home = (await homeDir()).trim()
    return home ? stripTrailingSlash(home) : undefined
  } catch {
    return undefined
  }
}
