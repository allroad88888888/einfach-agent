// workspace 边界判定的纯逻辑：一个候选路径算不算「在 root 里面」
// ---------------------------------------------------------------------------
// 对齐 apps/desktop/src/ 的 Rust 实现——那边的边界判定散在 workspace_read_paths.rs /
// workspace_write_target_path.rs / workspace_patch_path.rs / workspace_delete.rs 各处，
// 但判据是同一条：`canonical.starts_with(root)`。Node 侧从一开始就把它收成一份。
//
// **本文件不碰文件系统**。判定与 IO 分开是刻意的：W16/W17 要把 Rust 测试的输入/期望抽成共享
// JSON fixture 两边双跑，而只有纯函数能在没有那棵临时目录树的情况下被逐条喂进去。真正需要
// realpath 的部分在 resolveWorkspacePath.ts。

import { dirname, isAbsolute, normalize, sep } from 'node:path'

/**
 * 路径分隔符。unix 只认 `/`（字面 `\` 是合法文件名的一部分，Rust 的 `Path::components`
 * 同样如此）；windows 两种都认。
 */
const SEGMENT_SEPARATOR = sep === '\\' ? /[\\/]+/ : /\/+/

/**
 * 候选路径是否落在 root 之内（root 自身算在内，与 Rust 的
 * `target == workspace_root || target.starts_with(workspace_root)` 一致）。
 *
 * **前缀陷阱**：Rust 的 `Path::starts_with` 是**按路径分量**比的，`/workspace-evil` 不以
 * `/workspace` 开头。直译成 `candidate.startsWith(root)` 就把这条性质丢了——`/workspace-evil`
 * 会被判为 workspace 内，而它是磁盘上另一个目录。所以这里一律在**分隔符边界**上比：
 * 要么完全相等，要么以 `root + sep` 开头。
 *
 * 大小写：与 Rust 一样按字节比较，不做大小写折叠。macOS 的默认文件系统大小写不敏感，于是
 * `/Ws/a` 对 root `/ws` 会被判为越界——方向是安全的（fail-closed），而且两个宿主同款，
 * 不会出现「桌面能读、Node 拒了」。
 *
 * 两个入参都必须是**已 canonicalize 的绝对路径**；传相对路径进来结果没有意义。
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate.startsWith(prefix)
}

/**
 * 把请求路径拼到 root 上：绝对路径原样返回，相对路径挂到 root 下。
 * 语义等价 Rust 的 `if requested.is_absolute() { requested } else { root.join(requested) }`。
 *
 * **刻意不用 `path.join` / `path.resolve`**：它们会先把 `..` 按词法消掉，而 POSIX 的
 * `realpath()`（也就是 Rust `fs::canonicalize` 的实现）是**先解符号链接再吃 `..`** 的。
 * 两者对同一个输入会给出不同的真实路径：设 `<root>/link` 是指向 `<外部>/dir` 的软链，
 * 那么 `link/../secret.txt`——
 *   · 词法先消：`<root>/secret.txt`（读到了 workspace 内的另一个文件）
 *   · POSIX 语义：`<外部>/secret.txt`（随后被 confinement 拒掉）
 * 本机实测 Node 的 `fs.realpathSync`（JS 实现）走前者、`fs/promises` 的 `realpath` 与
 * `realpathSync.native`（uv_fs_realpath）走后者。所以拼接必须保留 `..` 原样，交给 realpath 断案。
 */
export function joinRequestedPath(root: string, requested: string): string {
  if (isAbsolute(requested)) return requested
  const base = root.endsWith(sep) ? root.slice(0, -1) : root
  return `${base}${sep}${requested}`
}

/**
 * 路径里是否含 `..` 分量。
 *
 * 写入侧（Rust 的 `normalize_no_parent` / `normalize_path`）是**直接拒**，不是先消再判：
 * 目标文件可能还不存在，realpath 无从下手，此时唯一能守住的就是词法层面不许出现 `..`。
 * 读取侧不用它——那边路径必须已存在，可以让 realpath 解完再比边界，因此 `../` 是允许写法
 * （Auto 会话正靠它读 workspace 外的文件）。
 */
export function hasParentSegment(value: string): boolean {
  return value.split(SEGMENT_SEPARATOR).includes('..')
}

/** 路径里是否含 NUL——含 NUL 的路径传给系统调用是未定义行为，Rust 侧同样先拒。 */
export function hasNulByte(value: string): boolean {
  return value.includes('\0')
}

/**
 * 词法规范化：消掉 `.`、重复分隔符与结尾分隔符，等价 Rust 那个按 `Component` 逐段 push 的
 * `normalize_path`。
 *
 * **调用方必须先用 `hasParentSegment` 拒掉 `..`**——本函数用 `path.normalize`，它会把 `..`
 * 按词法消掉，而那正是上面 `joinRequestedPath` 解释过的、与 realpath 不一致的那种消法。
 */
export function normalizeLexically(value: string): string {
  const normalized = normalize(value)
  // 结尾分隔符要去掉（Rust 的 push 式规范化不会留），但 `/` 和 `C:\` 这种「自己就是自己的
  // 父目录」的文件系统根不能被削成空串或 `C:`。
  if (normalized.endsWith(sep) && dirname(normalized) !== normalized) {
    return normalized.slice(0, -1)
  }
  return normalized
}

/** 该路径是不是文件系统根（unix 的 `/`、windows 的 `C:\`）——等价 Rust 的 `parent().is_none()`。 */
export function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path
}
