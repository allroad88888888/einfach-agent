// 变更日志的数据模型：磁盘上那份条目 JSON 长什么样
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_types.rs（已随 T1 删除）。本文件**只有类型声明**——构造、
// 比较、解析各住一个文件（fileSnapshot.ts / buildChangeSet.ts / parseChangeSet.ts）。分开不是
// 洁癖：W16/W17 要拿这块做跨语言对拍，而对拍要能「不建临时目录树就喂 fixture」，前提就是纯
// 逻辑不和 IO 编排搅在一起。
//
// 变更日志是「不可逆动作可撤销」的**唯一凭据**：write / patch / delete / copy / move 在动手之前
// 先把「原来长什么样」记进这里，`revert_workspace_change` 只认这份记录。所以一条记漏、一个键名
// 写错，对应的那次改动就永久撤不回来——而且全程不报错。
//
// ═══ 三条照抄 Rust 才成立的约定 ═══
//  1. **键名一律 camelCase**。Rust 侧每个 struct 都带 `#[serde(rename_all = "camelCase")]`，于是
//     磁盘上写的是 `sessionId` / `movedPaths` / `createdAt`。注意承载 change context 的**顶层命令
//     参数**叫 `change_context`（snake_case），而它的**值**是 camelCase——两条命名规则在同一个
//     对象里并存，见 commandPayloads.ts 的同一段说明。
//  2. **可空字段写成 `T | null` 而不是 `T?`**。`JSON.stringify` 会把值为 `undefined` 的键整个丢掉，
//     而 Rust 的 `Option<T>`（这几个都没有 `skip_serializing_if`）序列化成显式 `null`。用 `?` 的
//     后果是 Node 写出来的条目比 Tauri 写的少几个键——同一份日志两个宿主写出两种形状，不报错，
//     等套壳之后才在「桌面版做的改动在 Web 版里撤不了」时兑现。
//  3. **字段顺序就是磁盘上的顺序**。serde 按声明顺序输出，`JSON.stringify` 按插入顺序输出，所以
//     buildChangeSet.ts 里的对象字面量必须与本文件的声明顺序一致，两个宿主写出的条目才逐字节
//     相同。这条不影响正确性，只影响对拍与 diff 可读性——但不写下来就没人会维持它。

// change context 的形状**不在本文件声明**：它已经是 commandPayloads.ts 的公开面（写类命令的入参
// 载荷），那里是唯一权威。这里只按 Rust 侧的名字把它接出来，免得同一个四字段结构在包里有两份
// 各自演化的声明。
export type { WorkspaceChangeContextArgs as WorkspaceChangeContext } from '../../commandPayloads'

/** 条目的三种状态。Rust 侧枚举带 `rename_all = "snake_case"`，磁盘上就是这三个小写字面量。 */
export type ChangeStatus = 'prepared' | 'applied' | 'reverted'

/**
 * 一个文件在某一时刻的完整快照。
 *
 * `content` 为 `null` 表示「那一刻这个文件不存在」——回滚时写 `null` 的语义是**删除**该文件，
 * 不是「写入空文件」（空文件是 `content: ''`）。两者差一个字符，后果是删除与清空之别。
 */
export interface FileSnapshot {
  /** 与 `content !== null` 同义。冗余存一份是 Rust 的形状，照抄。 */
  exists: boolean
  /** `content` 的 sha256 十六进制小写；`content` 为 null 时也是 null。 */
  hash: string | null
  content: string | null
}

/** 一个被整文件改写的文件：改前与改后各一份快照。 */
export interface ChangedFile {
  /** workspace 相对路径（`/` 分隔）。回滚时按它在 workspace root 下重新解析。 */
  path: string
  before: FileSnapshot
  after: FileSnapshot
}

/**
 * 一条被删除的路径。文件内容不在条目里，而是整份挪进 `<changeId>.payload`——删除的可能是一整棵
 * 目录树，塞进 JSON 既撑爆条目也丢权限位。
 */
export interface MovedPath {
  path: string
}

/** 一条被新建出来的路径（copy 的目标）。`fingerprint` 用于回滚前确认它没被人动过。 */
export interface TrackedPath {
  path: string
  fingerprint: string
}

/** 一次移动：`source` 已消失、`destination` 已出现。`fingerprint` 描述 `destination`。 */
export interface RelocatedPath {
  source: string
  destination: string
  fingerprint: string
}

/** 一次工具调用记下的整份账。磁盘上一个 `<changeId>.json` 就是它。 */
export interface WorkspaceChangeSet {
  id: string
  sessionId: string
  runId: string
  toolCallId: string
  /** canonicalize 之后的 workspace root 绝对路径。回滚时逐字比对，不一致即拒绝。 */
  workspaceRoot: string
  /**
   * 创建时刻，**epoch 纳秒**（对齐 Rust 的 `u128`）。批量回滚按它排序决定执行顺序。
   *
   * JS 的 `number` 在 1.7e18 量级上间距约 256 ns，所以这个值的低位是不精确的。这不构成问题：
   * 它只用来排序，从不参与相等判断，也不是任何东西的身份。见 prepare.ts 的时钟说明。
   */
  createdAt: number
  status: ChangeStatus
  files: ChangedFile[]
  movedPaths: MovedPath[]
  createdPaths: TrackedPath[]
  relocatedPaths: RelocatedPath[]
}

/** 登记成功后回给调用方的回执。core 的 `normalizeChangeSummary` 只认这两个键。 */
export interface WorkspaceChangeSummary {
  id: string
  reversible: boolean
}

/** `prepareChangeSet` 的单个文件入参：改前/改后的文本，`null` 表示那一刻文件不存在。 */
export interface ChangeFileInput {
  path: string
  before: string | null
  after: string | null
}

// ── 以下两个类型是回滚（W15）的输出形状。声明放这里是因为 Rust 侧同样声明在 types.rs 里，
// 而「共享类型住在明确的一个文件」正是本域第一张卡该定下来的事。构造它们的工厂（Rust 的
// `error_result`）属于回滚实现，不在本卡。

export interface WorkspaceChangeConflict {
  path: string
  reason: string
}

/**
 * 回滚结果。`status` 的取值与 core 的 `WorkspaceRevertResult['status']` 一一对应——那边是
 * 消费端的收窄，这边是产出端的承诺，写成同一个 union 才能在改动时一起红。
 */
export interface WorkspaceRevertResult {
  ok: boolean
  status:
    | 'ready'
    | 'batch_ready'
    | 'reverted'
    | 'batch_reverted'
    | 'already_reverted'
    | 'conflict'
    | 'workspace_mismatch'
    | 'missing_payload'
    | 'failed'
  restoredFiles: string[]
  conflicts: WorkspaceChangeConflict[]
  error: string | null
  revertedChangeSetIds: string[]
}
