// 连接登记表：谁在哪个库文件上开着句柄，以及怎么惰性把它带起来
// ---------------------------------------------------------------------------
// ═══ 用哪个 SQLite 驱动：`node:sqlite`（Node 内置） ═══
// 选它的第一理由是**分发**。本包最终要随 npm 走（`npx web-agent`，D 线），而这棵树存在的全部
// 动机就是绕开桌面版那条要证书、要签名的发布链路。`better-sqlite3` / `node-sqlite3` 都是原生
// 插件：用户安装时要么撞上预编译二进制的 (OS × arch × Node ABI) 矩阵，要么现场 node-gyp 编译
// （Python + C++ 工具链）。那是「一条命令就能跑起来」和「装不上时用户根本无从下手」的分界线。
// `sql.js`（wasm）连候选都算不上：它整库在内存里，落盘要自己把整个文件写回去——而本仓库的
// 持久化模型恰恰建立在「每次写入是一条自包含的原子语句」之上，用它等于把耐久性重写一遍。
// `node:sqlite` 是**零依赖**：不新增任何 package.json 条目，没有编译，也没有二进制矩阵。
//
// 代价是它目前标着 experimental：进程里第一次加载会打一行
// `ExperimentalWarning: SQLite is an experimental feature…`（Node 的实验特性警告**每进程只打
// 一次**，不会刷屏），API 也可能在 Node 大版本间变。对冲手段是范围：全仓对 node:sqlite 的引用
// 只有本文件这一处 `import()`，其余代码只认 P1 的 `SqlExecutor`——真要换驱动，改的是这一个文件。
//
// 版本门槛：`node:sqlite` 自 Node 22.5 起存在，22.13 / 23.4 起**不再需要** `--experimental-sqlite`
// 旗标。仓库 CI 用 `node-version: 22`（解析到最新 22.x），本机 24.14，都在门槛之上。低于门槛时
// 下面那次 `import()` 会失败，`describeUnavailable` 把它翻成一句指得出病因的话——而不是让调用方
// 收到一个「模块找不到」然后按「持久化不可用」静默降级。
//
// ═══ 为什么登记表是模块级的 ═══
// 键是 **(逻辑连接名, 解析后的库文件路径)**，也就是「这台机器上的这个文件由谁开着」——那是进程
// 的属性，不是某一张路由表的属性。做成随 `createSqliteRoutes` 创建的实例反而会出问题：同一个
// 宿主里 CLI 进程内的执行面（`createNodeSqlExecutorLoader`）与 HTTP 路由表是两次装配，做成实例
// 就会在同一个文件上开出两倍的句柄。测试之间的隔离由**路径**天然给出（各自的临时目录），
// 不需要靠实例边界。这一点与 mcp 域刻意的「管理器随路由表创建」相反，理由也正相反：那边的
// 会话登记表是那张表的私有状态，两次装配本就不该互相看见。

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'
import { createSqliteExecutor } from './nodeSqliteExecutor'
import type { SqliteConnectionName } from './connectionNames'

interface OpenConnection {
  readonly database: DatabaseSync
  readonly executor: SqlExecutor
}

/** 键 = 连接名 + NUL + 路径。NUL 不可能出现在两者任一，拼出来的键不会撞。 */
const connections = new Map<string, Promise<OpenConnection>>()

function describeUnavailable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(
    '当前 Node 运行时没有内置的 node:sqlite 模块。Node 宿主的 SQLite 持久化需要 Node 22.13 ' +
      '（或 23.4）以上——更早的版本要么没有这个模块，要么需要 --experimental-sqlite 旗标。' +
      `原始错误：${detail}`,
    { cause: error },
  )
}

async function openConnection(
  connectionLabel: string,
  databasePath: string,
): Promise<OpenConnection> {
  let DatabaseConstructor: typeof DatabaseSync
  try {
    // 动态 import：本包的 barrel 会被浏览器侧的构建图碰到（`nodeHostPlatform` 等），顶层
    // import 一个 Node 内置模块会把它拖进那张图。同时这也保住了惰性——真正打开库文件的时点
    // 推迟到第一次执行 SQL，与 P1 收 loader 而不收已就绪 executor 的理由是同一个。
    const nodeSqlite = await import('node:sqlite')
    DatabaseConstructor = nodeSqlite.DatabaseSync
  } catch (error) {
    throw describeUnavailable(error)
  }
  // 桌面侧由 Tauri 的 path API 保证应用数据目录存在，Node 侧得自己建。权限不特意收紧到 0700：
  // 这份库文件是**应用数据**、不是凭证（凭证在 `~/.webAgent/config.json`，那份由 config 域强制
  // 0600/0700），而桌面版在同一个位置写的就是默认权限——收紧只会让两个宿主在同一个文件上
  // 互相改权限。
  await mkdir(dirname(databasePath), { recursive: true })
  const database = new DatabaseConstructor(databasePath)
  return { database, executor: createSqliteExecutor(database, connectionLabel) }
}

/**
 * 取（必要时打开）一条连接的执行面。同一对「名字 + 路径」整个进程只打开一次。
 *
 * 缓存的是 **promise** 而不是结果：打开过程里有 `await`（动态 import 与建目录），缓存结果的话
 * 两次并发的首次调用会各开一个句柄，而后一个把前一个从表里挤掉——被挤掉的那个再也关不上。
 */
export async function loadSqliteExecutor(
  connection: SqliteConnectionName,
  databasePath: string,
): Promise<SqlExecutor> {
  const key = `${connection}\u0000${databasePath}`
  let pending = connections.get(key)
  if (!pending) {
    pending = openConnection(`${connection}@${databasePath}`, databasePath)
    connections.set(key, pending)
    // 打开失败就把 memo 撤掉，允许下次重试（并把错误透传给当前调用方）。同 persistence-sqlite
    // 的 `getDb()`：留着一个已失败的 promise 会让「第一次没建成目录」永久化。
    const failed = pending
    failed.catch(() => {
      if (connections.get(key) === failed) connections.delete(key)
    })
  }
  return (await pending).executor
}

/**
 * 关掉全部连接。宿主关停时由装配层调用（也是测试释放临时目录前的必要一步）。
 *
 * **不在本域自己挂 `registerHostDisposer`**：那是所有域共用的一个槽，语义（挂一个还是攒一串）
 * 由装配层定，而 C5 正在并行落地它。不关也不会丢数据——WAL 模式下已提交的写入本就是耐久的，
 * 少的只是一次收尾 checkpoint 与两个 `-wal` / `-shm` 文件。
 */
export async function closeSqliteConnections(): Promise<void> {
  const pending = [...connections.values()]
  connections.clear()
  for (const entry of pending) {
    try {
      const opened = await entry
      opened.database.close()
    } catch {
      // 打开失败的连接与已经关掉的句柄都会走到这里；关停路径上没有比「继续关下一个」更好的事做。
    }
  }
}
