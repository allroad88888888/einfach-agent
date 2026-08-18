// `write_workspace_file` 的回执形状，与「结构化失败」这一个概念
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_result.rs。
//
// 【顶层键是 snake_case，这不是笔误】
// `WorkspaceWriteResult` 在 Rust 侧只有 `#[derive(Serialize)]`，**没有** `rename_all`，所以线上
// 那份 JSON 的键就是 `bytes_written` / `change_set` / `change_summary` / `reversible_reason` /
// `dry_run` / `would_change`。而同一个仓库里 `workspace_read_types.rs` 与
// `workspace_patch_result.rs` 的结果结构都带 `rename_all = "camelCase"`——**读/补丁是驼峰、写是
// 下划线**，这是 Rust 侧真实存在的不一致。core 的 `normalizeResult` 两种都收
// （`raw.bytesWritten ?? raw.bytes_written`），所以两边今天都能跑；但线上字节不同，
// W16/W17 的跨语言对拍会撞上。**照搬未改**：结果形状是两个宿主的对外契约，Node 单方面改成
// 驼峰，等于让同一条命令在两个宿主下发出两种 JSON。
//
// 【null 与「键不存在」是两回事】
// Rust 里只有 `reversible_reason` 带 `skip_serializing_if = "Option::is_none"`，它为 None 时那个
// 键**根本不出现**；`error` / `change_set` / `change_summary` 没有这个属性，为 None 时是显式
// `null`。所以这里前者写成可选属性、后者写成 `T | null`。`JSON.stringify` 之后两者看不出差别，
// 但进程内注入（CLI / sidecar）时调用方拿到的是对象本身，`'reversible_reason' in result` 会给出
// 两种答案。

import type { WorkspaceChangeSummary } from '../change/types'
import type { FileChangeSummary } from './changeSummary'

/** 一次写入的回执。失败也是它（`ok: false` + `error`），不是 rejection。 */
export interface WorkspaceWriteResult {
  ok: boolean
  /** 根相对的展示路径；**在路径解析成功之前**失败的话，是调用方原样传进来的那个串。 */
  path: string
  /** 本次写进去的字节数（append 时只算追加的那段，不是文件总长）。dry run 恒为 0。 */
  bytes_written: number
  created: boolean
  overwritten: boolean
  appended: boolean
  error: string | null
  /** 变更日志回执。只有「带 change_context 且这次写入可逆」时才有。 */
  change_set: WorkspaceChangeSummary | null
  /** 磁盘上实际改了什么，省得调用方为确认一次编辑再读一遍文件。 */
  change_summary: FileChangeSummary | null
  /** 这次写入有没有留下回滚记录。二进制与超预算的内容照写，只是撤不回来。 */
  reversible: boolean
  /** 不可逆的理由。只在 `reversible` 为 false 时出现（为 true 时**键不存在**）。 */
  reversible_reason?: string
  dry_run: boolean
  would_change: boolean
}

/**
 * 一次「按设计拒绝」的写入。
 *
 * Rust 侧这些分支返回的是 `Ok(error_result(...))`——失败仍是一份正常回执，不是 IPC 层的错误。
 * Node 侧没有 `Result`，若照着写就得在流水线里串十几个 `if (err) return errorResult(...)`，而其中
 * 一段还必须发生在锁里。所以本域统一用这个异常当**结构化失败的载体**：所有「按设计拒绝」的点
 * 抛它，流水线最外层一把捞起来折成 `errorResult`。
 *
 * 刻意**不**捞普通 `Error`：那样一个真正的编程错误（拼错属性名、undefined 上取属性）会被整形成
 * 一次「模型看得懂的失败」，症状是模型收到一句莫名其妙的英文然后重试，病因埋在十几层调用之下。
 * 非 WriteRejection 的异常原样上抛，由分发层变成 invoke rejection——响亮地失败。
 */
export class WriteRejection extends Error {
  override readonly name = 'WriteRejection'
}

/** 按设计拒绝这次写入。返回类型是 `never`，调用处不必再写 `return`。 */
export function rejectWrite(message: string): never {
  throw new WriteRejection(message)
}

/**
 * 结构化失败回执。等价 Rust 的 `error_result`：除了 `path` 与 `error`，其余字段一律是「什么都
 * 没发生」的取值——注意 `reversible` 是 **false**（失败从来没产出过变更集），
 * `would_change` 也是 false。
 */
export function errorResult(path: string, error: string): WorkspaceWriteResult {
  return {
    ok: false,
    path,
    bytes_written: 0,
    created: false,
    overwritten: false,
    appended: false,
    error,
    change_set: null,
    change_summary: null,
    reversible: false,
    dry_run: false,
    would_change: false,
  }
}
