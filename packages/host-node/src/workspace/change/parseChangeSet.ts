// 把读回来的 JSON 收窄成条目对象
// ---------------------------------------------------------------------------
// 桌面端这一步是 `serde_json::from_str::<WorkspaceChangeSet>` 代劳的；Node 侧 `JSON.parse` 只给
// `any`，收窄得自己写。纯函数（收 `unknown`、不碰磁盘），IO 在 entryStore.ts。
//
// **宽严刻度逐条对齐 serde 的 derive**，既不多也不少——严了会拒掉桌面版写的合法条目，松了会让
// 一份坏条目在回滚时被当成真相用下去：
//   · 未知键 **忽略**（Rust 侧没有 `deny_unknown_fields`）。
//   · `files` / `movedPaths` / `createdPaths` / `relocatedPaths` 缺失 → 空数组（`#[serde(default)]`）。
//   · `FileSnapshot` 的 `hash` / `content` 缺失 → `null`。这是 serde 对 `Option<T>` 字段的特判，
//     不是「所有字段都可缺省」：serde-1.0.228 `src/private/de.rs:45-50` 里 `missing_field` 的
//     `deserialize_option` 直接 `visit_none()`。查过才敢照抄——照记忆写的话，这里很容易变成
//     「缺字段就报错」，于是 Node 拒掉一批桌面端写的条目。
//   · 其余字段一律必需，类型不符即拒。
//
// ⚠️ 上面第三条有个**照抄下来的危险语义**，留给 W15 与后续评审判断，本卡不擅自改：条目里
// `content` 缺失会被当成 `null`，而回滚时 `null` 的含义是**删除该文件**。也就是说一份被截断的
// 条目不会让回滚失败，而是让它删掉用户的文件。Rust 侧今天就是这个行为。要改的话该两边一起改
// （加一条 `exists === (content !== null)` 的自洽校验），不该由 Node 单方面收紧。

import type {
  ChangeStatus,
  ChangedFile,
  FileSnapshot,
  MovedPath,
  RelocatedPath,
  TrackedPath,
  WorkspaceChangeSet,
} from './types'

const CHANGE_STATUSES: readonly string[] = ['prepared', 'applied', 'reverted']

/** 收窄失败即抛。消息只描述哪个字段坏了——它会被调用方包进 Rust 那句 `invalid change set ...`。 */
export function parseChangeSet(value: unknown): WorkspaceChangeSet {
  const source = record(value, 'change set')
  return {
    id: text(source, 'id', ''),
    sessionId: text(source, 'sessionId', ''),
    runId: text(source, 'runId', ''),
    toolCallId: text(source, 'toolCallId', ''),
    workspaceRoot: text(source, 'workspaceRoot', ''),
    createdAt: wholeNumber(source, 'createdAt', ''),
    status: status(source.status),
    files: list(source.files, 'files', changedFile),
    movedPaths: list(source.movedPaths, 'movedPaths', movedPath),
    createdPaths: list(source.createdPaths, 'createdPaths', trackedPath),
    relocatedPaths: list(source.relocatedPaths, 'relocatedPaths', relocatedPath),
  }
}

function status(value: unknown): ChangeStatus {
  if (typeof value !== 'string' || !CHANGE_STATUSES.includes(value)) {
    throw new Error('unknown value for field `status`')
  }
  return value as ChangeStatus
}

function changedFile(value: unknown, at: string): ChangedFile {
  const source = record(value, at)
  return {
    path: text(source, 'path', at),
    before: fileSnapshot(source.before, `${at}.before`),
    after: fileSnapshot(source.after, `${at}.after`),
  }
}

function fileSnapshot(value: unknown, at: string): FileSnapshot {
  const source = record(value, at)
  return {
    exists: flag(source, 'exists', at),
    hash: nullableText(source, 'hash', at),
    content: nullableText(source, 'content', at),
  }
}

function movedPath(value: unknown, at: string): MovedPath {
  return { path: text(record(value, at), 'path', at) }
}

function trackedPath(value: unknown, at: string): TrackedPath {
  const source = record(value, at)
  return { path: text(source, 'path', at), fingerprint: text(source, 'fingerprint', at) }
}

function relocatedPath(value: unknown, at: string): RelocatedPath {
  const source = record(value, at)
  return {
    source: text(source, 'source', at),
    destination: text(source, 'destination', at),
    fingerprint: text(source, 'fingerprint', at),
  }
}

/** 缺失 → 空数组（`#[serde(default)]`）；给了别的东西 → 拒。 */
function list<T>(value: unknown, key: string, item: (entry: unknown, at: string) => T): T[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`invalid type for field \`${key}\``)
  return value.map((entry, index) => item(entry, `${key}[${index}]`))
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid type for \`${at}\``)
  }
  return value as Record<string, unknown>
}

/** 字段的可读位置：顶层是裸键名，嵌套是 `files[0].before.hash` 这样的路径。 */
function label(at: string, key: string): string {
  return at ? `${at}.${key}` : key
}

function text(source: Record<string, unknown>, key: string, at: string): string {
  const value = source[key]
  if (value === undefined) throw new Error(`missing field \`${label(at, key)}\``)
  if (typeof value !== 'string') throw new Error(`invalid type for field \`${label(at, key)}\``)
  return value
}

/** `Option<String>`：缺失与 `null` 同义，见文件头。 */
function nullableText(source: Record<string, unknown>, key: string, at: string): string | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`invalid type for field \`${label(at, key)}\``)
  return value
}

function flag(source: Record<string, unknown>, key: string, at: string): boolean {
  const value = source[key]
  if (value === undefined) throw new Error(`missing field \`${label(at, key)}\``)
  if (typeof value !== 'boolean') throw new Error(`invalid type for field \`${label(at, key)}\``)
  return value
}

/** Rust 侧是 `u128`：必须是非负整数。JSON 里的浮点或负数是坏条目，不是「四舍五入一下」。 */
function wholeNumber(source: Record<string, unknown>, key: string, at: string): number {
  const value = source[key]
  if (value === undefined) throw new Error(`missing field \`${label(at, key)}\``)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid type for field \`${label(at, key)}\``)
  }
  return value
}
