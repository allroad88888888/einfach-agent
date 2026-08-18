// 本域「用户主目录是什么」的唯一权威
// ---------------------------------------------------------------------------
// 抽出来是因为本域有两个消费者：`get_user_home_dir` 命令（把它回给 core 当 skills 扫描根）
// 与 `~/.webAgent/config.json` 的路径解析。两处各写一遍 `options.homeDir ?? homedir()`
// 不会编译失败，但漂移时的症状分别是「skills 扫不到」和「配置读到另一个文件」——两者都不报错，
// 也都不指向病因。hostOptions.ts 的第 2 条纪律说的就是这个：一个事实只能有一个权威。

import { homedir } from 'node:os'
import type { NodeHostInvokeOptions } from '../hostOptions'

/** 去掉结尾斜杠（保留根 `/`）。口径与 core 的 runtime/userSkillsRoot.ts 一致。 */
export function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

/**
 * 解析主目录：装配槽 `homeDir` 优先，缺省回落 `os.homedir()`。
 *
 * 抛错而不是返回空串：`os.homedir()` 在极少数环境（无 HOME、无 passwd 条目）下会给出空值，
 * 而空串一旦被当成路径根用下去，`join('', '.webAgent', 'config.json')` 会指向**相对**当前
 * 工作目录的 `.webAgent/config.json`，凭证于是写进了随便哪个 cwd 里，且全程不报错。
 */
export function resolveHomeDirectory(options: NodeHostInvokeOptions): string {
  const configured = options.homeDir?.trim()
  const resolved = stripTrailingSlash(configured || homedir().trim())
  if (!resolved) throw new Error('Node 宿主无法定位用户主目录（os.homedir() 返回空值）')
  return resolved
}
