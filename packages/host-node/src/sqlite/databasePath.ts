// 库文件在这台机器上的哪个位置
// ---------------------------------------------------------------------------
// 桌面宿主当年写的是 `sqlite:web-agent.db`——一个**相对路径**，由 Tauri SQL 插件解析到应用数据
// 目录（`com.webagent.app/web-agent.db`）。「用哪个库文件」这个决定天然属于宿主（P1 把它从 driver
// 包搬到装配层的理由也在此），所以 Node 宿主要自己给出一个绝对路径。
//
// ═══ 这个位置为什么长这样（以及那个理由今天已经失效） ═══
// P2 当时的判据是「使两个宿主看到同一份会话」：同一台机器上桌面版与浏览器自托管版会交替使用，
// 会话落在两个文件里 = 用户看到两份互不相干的历史，而这不会报错。所以下面复刻的是 Tauri
// `app_data_dir()` 的算法（Rust `dirs` crate 的 `data_dir()` + 应用标识符），不是另起一套。
//
// **桌面端已随 T1 删除，不再有"另一个宿主"要对齐。** 这里保持不动，理由换成两条，都仍然成立：
//   · 浏览器自托管与 CLI 是**两个进程**，它们必须落在同一个文件上，否则「CLI 跑的会话在界面里
//     看不到」——这正是 P2 想避免的症状，只是主角换了一对。
//   · 本机上已经存在的库文件就在那个路径下。挪位置等于让存量会话静默消失。
// 换句话说：路径的**形式**是历史包袱（`com.webagent.app` 是当年 Tauri 的 identifier），
// 但换它是一次数据迁移，不是改一个常量。
//
// ═══ 为什么**不**跟随 `WEB_AGENT_CONFIG_DIR` ═══
// 那个环境变量的语义是「选配置目录」（CLAUDE.md 明说：只选目录、不接受也不返回模型 Key），
// 让它顺带搬走库文件，等于让「多实例隔离配置」这一个开关做两件事——而上面那条「浏览器与 CLI
// 落在同一个文件上」的判据会恰好在最需要它的场景（用户给两个进程设了不同的配置目录）失效。
// 要换库文件请用下面的 `databasePath` 装配槽，那是显式的。
//
// 主目录**不在这里重新解析**：`../config/homeDirectory.ts` 已经是本包「用户主目录是什么」的
// 唯一权威（装配槽 `homeDir` 优先、回落 `os.homedir()`、空值当场抛错）。再写一遍
// `options.homeDir ?? homedir()` 不会编译失败，但漂移时的症状是「浏览器版读到的会话跟 CLI
// 写的不是同一份」，且全程不报错。

import { isAbsolute, join, posix, win32 } from 'node:path'
import { resolveHomeDirectory } from '../config/homeDirectory'
import type { NodeHostInvokeOptions } from '../hostOptions'

/** 应用数据目录名。取自桌面端 `apps/desktop/tauri.conf.json` 的 `identifier`；那个文件已随 T1
 *  删除，这个字符串因此**只由本文件决定**——它同时是存量库文件的实际位置，改它要做数据迁移。 */
const APPLICATION_IDENTIFIER = 'com.webagent.app'
/** 库文件名。沿用桌面侧 `Database.load('sqlite:web-agent.db')` 的相对路径，同上：改它要迁数据。 */
const DATABASE_FILE = 'web-agent.db'

/**
 * sqlite 域自己的装配槽。**有意不加进 hostOptions.ts**——那是所有域共用的文件，M / C / P 三条线
 * 正并行落地各自的域，同时改它必冲突（同 mcp 域的 `McpRoutesOptions`）。槽是可选的，所以一个
 * 普通的 `NodeHostInvokeOptions` 原样传进来即可编译。
 */
export interface SqliteRoutesOptions extends NodeHostInvokeOptions {
  /**
   * 库文件的**绝对路径**。不传 → 解析到本机默认位置（见本文件头）。
   *
   * 留这个槽有两个真实用途，都不是「能自己算出来的东西」：
   *   · server 宿主可能跑在容器/服务账号下，数据要落在挂载卷而不是 HOME 里；
   *   · 测试必须能完全避开运行测试那个人的真实库文件。
   *
   * 相对路径**受控失败**而不是按 cwd 解析：按 cwd 解析的后果是同一份配置在不同工作目录下开出
   * 不同的库，症状同样是「会话不见了」。
   */
  databasePath?: string
}

/**
 * 应用数据目录的父目录（Rust `dirs::data_dir()` 的等价物）。
 *
 * 三个平台各自的判据逐条对齐 `dirs`：
 *   · macOS：`$HOME/Library/Application Support`（不看环境变量）。
 *   · Windows：`%APPDATA%`（漫游目录），缺失时回落 `$HOME/AppData/Roaming`。
 *   · 其余（Linux/BSD）：`$XDG_DATA_HOME`，**且必须是绝对路径**，否则 `$HOME/.local/share`。
 *
 * 「必须是绝对路径」不是多余的严格：`dirs` 的实现是
 * `env::var_os("XDG_DATA_HOME").and_then(dirs_sys::is_absolute_path)`，相对值会被它丢掉并回落。
 * 顺带这也挡住空串——空串不是绝对路径。仓库里另一份同款实现（`vite.config.ts` 的
 * `defaultTraceDbPath`）两条都漏了，写成 `process.env.XDG_DATA_HOME ?? …`：`??` 只挡
 * null/undefined，`XDG_DATA_HOME=` 会让 `path.join('', …)` 变成跟着进程 cwd 走的相对路径。
 * 那份是 dev-only 的 trace 读取脚本、不在本卡改动面（issue 树「顺带发现的 TS 侧 bug」#10）。
 *
 * 平台与环境**从参数进**而不是在函数体里读 `process`：这样三个分支都能被直接测到，不必去改
 * 全局的 `process.platform`（那种改法一旦某条用例中途抛错就会污染同一个 worker 里后面的用例）。
 * 路径语义（`isAbsolute` / `join`）也跟着参数走 `win32` / `posix` 两个具名实现，而不是
 * `node:path` 的默认导出——默认导出是**本机**平台的那一套，`C:\…` 在 macOS 上判不出绝对路径，
 * 于是「按参数选平台」会给出一个本机跑不到的分支结果。运行时传的是 `process.platform`，
 * 选出来的正是本机那一套，行为与直接用默认导出完全一致。
 */
export function sqliteDataDirectory(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const paths = platform === 'win32' ? win32 : posix
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support')
  if (platform === 'win32') {
    const roaming = env.APPDATA
    return roaming && paths.isAbsolute(roaming) ? roaming : paths.join(home, 'AppData', 'Roaming')
  }
  const xdg = env.XDG_DATA_HOME
  return xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, '.local', 'share')
}

/**
 * 本次装配该打开哪个库文件。返回绝对路径；父目录不保证存在（建目录是打开连接那一步的事）。
 */
export function resolveSqliteDatabasePath(options: SqliteRoutesOptions): string {
  const configured = options.databasePath?.trim()
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`SQLite 库文件路径必须是绝对路径：${configured}`)
    }
    return configured
  }
  const dataDirectory = sqliteDataDirectory(
    resolveHomeDirectory(options),
    process.platform,
    process.env,
  )
  return join(dataDirectory, APPLICATION_IDENTIFIER, DATABASE_FILE)
}
