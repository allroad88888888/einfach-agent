// `~/.webAgent/config.json` 的路径解析：默认路径、`WEB_AGENT_CONFIG_DIR` 覆盖、旧路径
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/web_agent_config_store.rs 的
// `from_home_directory_with_config_directory` + `validate_existing_config_directory`。
//
// 这里只回答「这次操作该读写哪个文件」，不碰文件内容——**旧路径迁移是否可能发生**由本文件
// 决定（`legacyPath` 是否为 undefined），迁移动作本身在 webAgentConfigStore.ts。
//
// ═══ 三条边界（本卡的核心，逐条对齐 CLAUDE.md「模型凭证与传输」）═══
//  1. `WEB_AGENT_CONFIG_DIR` **只选目录**。它进不来一个 Key，也带不走一个 Key——本文件对它做的
//     全部处理就是「当作目录路径」。它的用途是多实例隔离，不是凭证通道。
//  2. **只有默认路径才有 `legacyPath`**。设了覆盖目录时它是 `undefined`，于是迁移在机制上不可能
//     发生，而不是靠某处记得写一句 if。覆盖目录的语义是「这是一套独立的配置」，把另一套配置
//     悄悄复制进去会让两个实例共享凭证——正是隔离要防的事。
//  3. 覆盖目录**已存在**时必须是 0700 的目录。不合格是受控失败，**不回落默认目录**：回落会让
//     用户以为自己在用隔离配置，实际写的是主配置。

import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { resolveHomeDirectory } from './homeDirectory'
import type { NodeHostInvokeOptions } from '../hostOptions'

const CONFIG_DIRECTORY = '.webAgent'
/** 迁移前的旧目录名，带连字符。与上面的驼峰新目录只差一个字符，写错不会报错、只会读到空配置。 */
const LEGACY_CONFIG_DIRECTORY = '.web-agent'
const CONFIG_FILE = 'config.json'
export const CONFIG_DIRECTORY_ENV = 'WEB_AGENT_CONFIG_DIR'

/** 一次配置读写要用到的全部路径。`legacyPath` 为 `undefined` 表示「本次不允许迁移」。 */
export interface ConfigPaths {
  /** 本次读写的目标文件。 */
  readonly path: string
  /** 新文件不存在时可安全复制过来的旧文件；设了覆盖目录时恒为 `undefined`。 */
  readonly legacyPath: string | undefined
}

/**
 * 按主目录与覆盖值解析路径。
 *
 * `override` 的三态与 Rust 的 `Option<OsString>` 逐一对应：`undefined` = 环境变量没设置、
 * `''` = 设置了但为空（受控失败）、其余 = 目录路径。**空串不能塌成「没设置」**：那会让
 * `WEB_AGENT_CONFIG_DIR=` 静默回落到默认目录并触发迁移，而用户的本意是换一套配置。
 */
export async function resolveConfigPaths(
  home: string,
  override: string | undefined,
): Promise<ConfigPaths> {
  if (override === undefined) {
    return {
      path: join(home, CONFIG_DIRECTORY, CONFIG_FILE),
      legacyPath: join(home, LEGACY_CONFIG_DIRECTORY, CONFIG_FILE),
    }
  }
  if (override === '') throw new Error(`${CONFIG_DIRECTORY_ENV} 不能为空`)
  if (!isAbsolute(override)) throw new Error(`${CONFIG_DIRECTORY_ENV} 必须是绝对路径`)
  await assertUsableConfigDirectory(override)
  return { path: join(override, CONFIG_FILE), legacyPath: undefined }
}

/** 从装配槽与进程环境解析。命令 handler 用这一个；`resolveConfigPaths` 留给需要显式覆盖值的调用。 */
export async function resolveConfigPathsFromOptions(
  options: NodeHostInvokeOptions,
): Promise<ConfigPaths> {
  // 每次调用现读环境变量，与 Rust 的 `McpConfigStore::from_app`（每条命令建一次 store）一致。
  // 也不能在装配时读死：覆盖目录不合格时这里要抛错，而装配期抛错会连累另外 27 条命令。
  return resolveConfigPaths(resolveHomeDirectory(options), process.env[CONFIG_DIRECTORY_ENV])
}

/**
 * 覆盖目录**已存在**时的准入判定：必须是目录，且在 Unix 上权限恰为 0700。
 *
 * 不存在直接放行——首次使用时由 restrictedWrite.ts 创建并收紧到 0700。这里刻意不去**修**一个
 * 已存在目录的权限：那个目录是用户给的，可能根本不是配置目录（指错路径时 `chmod 700` 会把
 * 别人的目录改私有），受控失败比顺手修更安全。
 */
async function assertUsableConfigDirectory(directory: string): Promise<void> {
  let info
  try {
    info = await stat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`无法读取 ${CONFIG_DIRECTORY_ENV}`)
  }
  if (!info.isDirectory()) throw new Error(`${CONFIG_DIRECTORY_ENV} 必须是目录`)
  // Windows 的 mode 位不表达 POSIX 权限，判它只会误报。对齐 Rust 的 `#[cfg(unix)]`。
  if (process.platform === 'win32') return
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error(`${CONFIG_DIRECTORY_ENV} 目录权限必须为 0700`)
  }
}
