// 变更日志目录：浏览器自托管与 CLI 必须指向同一个地方
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal.rs（已随 T1 删除）的 `journal_dir`：
//
//     app.path().app_data_dir()?.join("workspace-changes")
//
// **这条算错不会报错，只会让日志静默分家。** 写这段时要对齐的是桌面版；桌面端随 T1 整条删除
// 之后，**判据没有消失、只是换了一对主角**：浏览器自托管与 CLI 是两个进程，它们必须看到同一份
// 日志。指向两个目录的症状是「CLI 里做的改动在界面里撤不了」，而 `revert_workspace_change`
// 收到的只是「读不到这个 change set」——看不出是路径问题。
// 另外，本机上已经存在的日志就在这个目录下：挪位置等于让存量变更静默变得不可撤销。
//
// ═══ `app_data_dir()` 到底是什么（逐层查证，不是照记忆写）═══
// tauri 2.11 `src/path/desktop.rs:247` → `dirs::data_dir()?.join(&config.identifier)`；
// identifier 当年取自 apps/desktop/tauri.conf.json 的 `"identifier": "com.webagent.app"`；那份
// 配置已随 T1 删除，于是**这个字符串今天只由本文件决定**——它同时是存量日志的实际位置，改它
// 要做数据迁移，不是改一个常量（同 sqlite/databasePath.ts 的记档）。
// dirs 6.0 `src/{mac,win,lin}.rs` 的 `data_dir()`：
//   · macOS  → `$HOME/Library/Application Support`（`mac.rs:7,12`，经 dirs-sys 的 home_dir，
//              它优先读非空 `$HOME`，与 Node 的 `os.homedir()` 同口径）
//   · Windows→ `FOLDERID_RoamingAppData`（`win.rs:10`，即通常的 `%APPDATA%`）
//   · Linux  → `$XDG_DATA_HOME`，**且仅当它是绝对路径**，否则 `$HOME/.local/share`
//              （`lin.rs:11`：`.and_then(dirs_sys::is_absolute_path)`）
// 与 vite.config.ts 的 `defaultTraceDbPath()` 是同一套推导（同一个 identifier）；那份少了 Linux
// 分支的绝对路径判定，是 dev 期 trace 读取器的小疏漏，不是本文件该跟随的口径。
//
// **有意与 Rust 不同的一处：Windows 上取 `%APPDATA%` 环境变量，而不是 Known Folder API。** Node
// 拿不到 `SHGetKnownFolderPath`，环境变量是标准替身；两者在正常账户上一致，只有被显式改写过
// `APPDATA` 的进程才会分歧——而那种进程本来就想让所有程序跟着改。
//
// **有意不加环境变量覆盖。** Rust 侧没有，加一个就等于多一处「两个宿主可能不一致」的旋钮。测试
// 不需要它：prepare / revert 全部把 `directory` 当第一个参数收，指哪写哪。

import { posix, win32 } from 'node:path'
import { resolveHomeDirectory } from '../../config/homeDirectory'
import type { NodeHostInvokeOptions } from '../../hostOptions'

const APP_IDENTIFIER = 'com.webagent.app'
const JOURNAL_DIRECTORY_NAME = 'workspace-changes'

/**
 * 推导所需的全部「本机事实」。做成入参而不是就地读 `process`，是为了让三平台推导本身是纯函数：
 * 一台 macOS 上就能把 Windows / Linux 两条分支都测穿，而这三条里错哪条都不报错。
 */
export interface AppDataFacts {
  platform: NodeJS.Platform
  env: Readonly<Partial<Record<string, string>>>
  /** 用户主目录的绝对路径。空值由调用方拦掉（见 config/homeDirectory.ts）。 */
  homeDir: string
}

/** Tauri `app_data_dir()` 的等价物：平台数据目录 + bundle identifier。 */
export function appDataDirectory(facts: AppDataFacts): string {
  // 按**目标平台**选路径语义，而不是跟随当前进程。否则在 macOS 上喂 `platform: 'win32'` 会拼出
  // 正斜杠路径，测试于是钉住了一个生产里不存在的形状。
  const path = facts.platform === 'win32' ? win32 : posix
  if (facts.platform === 'darwin') {
    return path.join(facts.homeDir, 'Library', 'Application Support', APP_IDENTIFIER)
  }
  if (facts.platform === 'win32') {
    const roaming = nonEmpty(facts.env.APPDATA) ?? path.join(facts.homeDir, 'AppData', 'Roaming')
    return path.join(roaming, APP_IDENTIFIER)
  }
  const configured = nonEmpty(facts.env.XDG_DATA_HOME)
  // 相对路径的 `XDG_DATA_HOME` 被 dirs 判为不可用而回落——照抄。少了这一句，`XDG_DATA_HOME=.local`
  // 会让日志跟着进程 cwd 走，两次启动写进两个目录。
  const base =
    configured && path.isAbsolute(configured)
      ? configured
      : path.join(facts.homeDir, '.local', 'share')
  return path.join(base, APP_IDENTIFIER)
}

/** 变更日志目录：`app_data_dir()/workspace-changes`。 */
export function journalDirectory(facts: AppDataFacts): string {
  const path = facts.platform === 'win32' ? win32 : posix
  return path.join(appDataDirectory(facts), JOURNAL_DIRECTORY_NAME)
}

/**
 * 从当前进程与装配槽推导。写类命令（W10/W11/W13）与回滚命令（W15）都用这一个，别各算各的。
 *
 * 主目录经 `resolveHomeDirectory` 取，跨到 config 域拿——那里是本包「主目录是什么」的唯一权威。
 * 在这里再写一次 `options.homeDir ?? homedir()` 不会编译失败，但 server 宿主以服务账号身份跑时
 * 两处会各得各的，日志目录于是和配置目录分了家，且不报错。
 */
export function defaultJournalDirectory(options: NodeHostInvokeOptions = {}): string {
  return journalDirectory({
    platform: process.platform,
    env: process.env,
    homeDir: resolveHomeDirectory(options),
  })
}

/** 空串按「没设置」处理：dirs 对 `HOME` 显式判空，对 `XDG_DATA_HOME` 经绝对路径判定间接排除。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}
