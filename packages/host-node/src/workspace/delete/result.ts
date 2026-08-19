// `delete_workspace_path` 的回执形状，与「结构化失败」这一个概念
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_delete.rs（已随 T1 删除）的 `WorkspaceDeleteResult` 与 `error_result`。
//
// 【顶层键：`change_set` 是 snake_case】
// 这个 struct 只有 `#[derive(Serialize)]`，**没有** `rename_all`，所以线上那份 JSON 的多词键就是
// `change_set`——与 write 域同款（docs/node-host-issues.md 第 12 条：同一仓库里读/补丁是驼峰、
// 写/删是下划线）。core 的 `normalizeResult` 两种都收（`raw.changeSet ?? raw.change_set`），
// 但线上字节不同，W16/W17 对拍会撞上。**照搬未改**：单方面改成驼峰等于让同一条命令在两个宿主
// 下发出两种 JSON。
//
// 【`null` 不是「键不存在」】
// 三个 `Option` 字段（`kind` / `error` / `change_set`）都**没有** `skip_serializing_if`，所以
// Rust 侧为 None 时序列化成显式 `null`。这里照此写成 `T | null` 而不是可选属性：`JSON.stringify`
// 之后两者看不出差别，但进程内注入（CLI / sidecar）时调用方拿到的是对象本身，`'kind' in result`
// 会给出两种答案。
//
// 【字段顺序 = 磁盘/线上的顺序】serde 按声明顺序输出，`JSON.stringify` 按插入顺序输出。两个工厂
// 里的对象字面量与下面的声明顺序一致，两个宿主发出的 JSON 才逐字节相同。

import type { WorkspaceChangeSummary } from '../change/types'

/** 一次删除的回执。失败也是它（`ok: false` + `error`），不是 rejection。 */
export interface WorkspaceDeleteResult {
  ok: boolean
  /** 根相对的展示路径；**在路径解析成功之前**失败的话，是调用方原样传进来的那个串。 */
  path: string
  deleted: boolean
  /** 删掉的是文件还是目录。失败时为 `null`（Rust 的 `Option<String>`）。 */
  kind: 'file' | 'directory' | null
  /**
   * 这次删除留下了回滚记录吗。
   *
   * **删除侧只有 true / false 两种，没有第三种「删了但撤不回来」**——成功即可逆（登记成功是成功
   * 的前提），失败即 false（什么都没发生）。write 域那种「照写但 `reversible: false`」的档位在
   * 这里不存在，理由见 limits.ts。
   */
  reversible: boolean
  error: string | null
  change_set: WorkspaceChangeSummary | null
}

/**
 * 一次「按设计拒绝」的删除。
 *
 * 与 write 域的 `WriteRejection` 同款、同理由：Rust 侧这些分支返回的是 `Ok(error_result(...))`
 * ——失败仍是一份正常回执，模型要能读到那句话并照着改。Node 侧没有 `Result`，照着写就得在流水线
 * 里串十几个 `if (err) return errorResult(...)`，所以统一用这个异常当载体，最外层一把捞起来。
 *
 * 刻意**不**捞普通 `Error`：那样一个真正的编程错误会被整形成一次「模型看得懂的失败」，症状是
 * 模型收到一句莫名其妙的英文然后重试，病因埋在十几层调用之下。非 `DeleteRejection` 的异常原样
 * 上抛，由分发层变成 invoke rejection——响亮地失败。
 */
export class DeleteRejection extends Error {
  override readonly name = 'DeleteRejection'
}

/** 按设计拒绝这次删除。返回类型是 `never`，调用处不必再写 `return`。 */
export function rejectDelete(message: string): never {
  throw new DeleteRejection(message)
}

/**
 * 结构化失败回执。等价 Rust 的 `error_result`：除 `path` 与 `error` 外一律是「什么都没发生」的
 * 取值——注意 `reversible` 是 **false**（失败从来没产出过变更集）。
 */
export function errorResult(path: string, error: string): WorkspaceDeleteResult {
  return {
    ok: false,
    path,
    deleted: false,
    kind: null,
    reversible: false,
    error,
    change_set: null,
  }
}

/** 成功回执。`reversible` 恒 true：走到这里说明账已经记上并标成 `applied` 了。 */
export function successResult(
  path: string,
  kind: 'file' | 'directory',
  changeSet: WorkspaceChangeSummary,
): WorkspaceDeleteResult {
  return {
    ok: true,
    path,
    deleted: true,
    kind,
    reversible: true,
    error: null,
    change_set: changeSet,
  }
}
