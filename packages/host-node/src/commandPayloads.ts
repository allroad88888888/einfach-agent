// 命令入参里的**嵌套载荷**形状（被多条命令共用的那些）
// ---------------------------------------------------------------------------
// 从 commandArgs.ts 分出来的理由不只是行数：这些类型描述的是「参数值内部长什么样」，它们的
// 命名规则与顶层参数名**不是同一条**（顶层看命令的 `rename_all`，内部看 Rust struct 自己的
// serde 属性，恒为 camelCase），而且同一个载荷会出现在好几条命令里。把它们和「命令 → 顶层
// 参数」的映射摊在一个文件里，读的人很容易把两条命名规则混成一条。
//
// 同样的免责声明适用：这里描述的是**调用方发什么**，handler 收到的仍是 `unknown`，要自己收窄。

/**
 * 变更日志上下文。写类命令（write / patch / delete / copy / move）带上它，宿主才会为这次改动
 * 记一笔可回滚的账；不带就是不可回滚的直接写。
 *
 * **字段是 camelCase**，尽管承载它的顶层参数名 `change_context` 是 snake_case——这是全表最容易
 * 踩的一处。形状移植自 apps/desktop/src/workspace_change_journal_types.rs 的
 * `WorkspaceChangeContext`（struct 上带 `rename_all = "camelCase"`）；那份 Rust 已随 T1 删除，
 * **本声明今天就是这个载荷的权威**，调用方（core 的 `toTauriInput`）按它写死。
 */
export interface WorkspaceChangeContextArgs {
  changeId: string
  sessionId: string
  runId: string
  toolCallId: string
}

/**
 * `apply_workspace_patch` 的单个操作。
 *
 * 判别键是 `type`，取值是 **snake_case**（Rust 侧 `#[serde(tag = "type", rename_all =
 * "snake_case")]`），而各变体的字段是 **camelCase**（逐字段 `#[serde(rename = "...")]`）——
 * 同一个对象里两种命名风格并存，不是笔误，照抄就对。
 * 形状移植自 apps/desktop/src/workspace_patch_operation.rs（已随 T1 删除，见 Git 历史）；
 * **本声明今天就是权威**。
 */
export type WorkspacePatchOperationArgs =
  | { type: 'add_file'; path: string; content: string; executable?: boolean }
  | { type: 'delete_file'; path: string; oldContent?: string; expectedContentHash?: string }
  | {
      type: 'replace'
      path: string
      oldText: string
      newText: string
      expectedReplacements?: number
    }
  | {
      type: 'overwrite_file'
      path: string
      content: string
      /** 覆盖已存在的文件必须给出 oldContent 或 expectedContentHash 之一（证明读过）。 */
      oldContent?: string
      expectedContentHash?: string
      executable?: boolean
    }

/**
 * MCP 握手交换的实现信息。除下列字段外还允许任意扩展键——Rust 侧那个 struct 带
 * `#[serde(flatten)] extra`，未知字段不会被拒绝也不会丢。
 */
export interface McpImplementationInfoArgs {
  name: string
  version: string
  title?: string
  [extra: string]: unknown
}
