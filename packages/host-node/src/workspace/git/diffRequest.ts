// `get_workspace_diff` 的入参收窄：`Record<string, unknown>` → 六个有类型的字段
// ---------------------------------------------------------------------------
// 桌面端这一层是 Tauri 的 command 反序列化白干的：`paths: Option<Vec<String>>` 收到一个数字数组
// 时，命令在进入函数体之前就以反序列化错误失败了。Node 这条路上没有那一层——路由表的 handler
// 收到的是一袋 `unknown`（载荷可能来自浏览器发的 JSON），所以形状校验必须自己做，而且必须做在
// 进 git 之前：漏做的话，一个 `paths: [123]` 会一路跑到 `spawn` 的 argv 里去。
//
// 【大小写】`get_workspace_diff` **带** `rename_all = "snake_case"`，顶层键就是 snake_case；
// core 的 `toTauriInput`（packages/agent-core/src/runtime/workspaceGit.ts）已经转好，这里照收，
// 不再转第二次。
//
// 【判存在只看值，不用 `'key' in args`】core 的 `toTauriInput` 是整份对象字面量返回，可选项没
// 有值时键**存在且为 undefined**；进程内注入时这些键原样到达 handler，走 HTTP 时
// `JSON.stringify` 又会把它们丢掉。同一份入参在两种传输下键集合不同，用 `in` 判断会写出
// 「本地能跑、上 server 就变」的 bug。
//
// 【`null` 等同缺席】serde 的 `Option<T>` 对 `null` 与「键不存在」给出同一个 `None`，照做。

/** 收窄后的入参。字段名转成 camelCase——从这里往下就是本包自己的内部形状了。 */
export interface WorkspaceDiffRequest {
  paths?: string[]
  staged?: boolean
  base?: string
  maxDiffChars?: number
  includeStat?: boolean
  workspaceRoot?: string
}

export function narrowWorkspaceDiffArgs(args: Record<string, unknown>): WorkspaceDiffRequest {
  return {
    paths: optionalStringArray(args.paths, 'paths'),
    staged: optionalBoolean(args.staged, 'staged'),
    base: optionalString(args.base, 'base'),
    maxDiffChars: optionalUsize(args.max_diff_chars, 'max_diff_chars'),
    includeStat: optionalBoolean(args.include_stat, 'include_stat'),
    workspaceRoot: optionalString(args.workspace_root, 'workspace_root'),
  }
}

/** 缺席：键不存在、值为 `undefined`、或值为 `null`（serde 的 `Option` 三者同义）。 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function optionalString(value: unknown, key: string): string | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'string') throw new Error(`get_workspace_diff 的 ${key} 必须是字符串`)
  return value
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'boolean') throw new Error(`get_workspace_diff 的 ${key} 必须是布尔值`)
  return value
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (isAbsent(value)) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`get_workspace_diff 的 ${key} 必须是字符串数组`)
  }
  return [...(value as string[])]
}

/**
 * Rust 侧这个参数是 `usize`：负数、小数、Infinity 在反序列化阶段就被拒。这里照拒而不是
 * 「夹一下凑合用」——`max_diff_chars: -1` 是调用方算错了，静默改成默认上限只会让它一直错下去。
 */
function optionalUsize(value: unknown, key: string): number | undefined {
  if (isAbsent(value)) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`get_workspace_diff 的 ${key} 必须是非负整数`)
  }
  return value
}
