// 每条宿主命令的**线上入参形状**
// ---------------------------------------------------------------------------
// 配套 commandNames.ts：那张表回答「有哪些命令」，这张表回答「每条命令收什么」。
//
// 【这些类型描述的是「调用方发什么」，不是「handler 可以假设什么」】
// 路由表的 handler 收到的一律是 `Record<string, unknown>`，**必须自己收窄**。理由是传输：
// 同一份路由表要同时挂在 `POST /api/invoke/:command`（S 线，载荷来自浏览器发的 JSON）、CLI
// 进程内注入（N8）和 Tauri sidecar（T 线）后面。HTTP 那条路上的载荷是外部输入，把本文件的
// 类型直接当成 handler 参数类型 = 用一句 `as` 把「没校验」伪装成「已校验」。
//
// 【大小写：顶层参数名按各命令的 Tauri rename 规则定，嵌套载荷一律 camelCase】
// 28 条里有 14 条带 `#[tauri::command(rename_all = "snake_case")]`，前端传的就是 snake_case；
// core 侧的 `toTauriInput` / `toTauriReadInput` 等转换函数已经转好了，**路由表接到的就是
// snake_case，不要再转一次**。另外 14 条没有 rename_all，走 Tauri 默认（JS 侧 camelCase →
// Rust 侧 snake_case）；这批里绝大多数参数是单词（`input` / `patch` / `provider` / `scope`）
// 或干脆无参，大小写无差别，**唯二的多词参数**是 `cancel_model_provider_request` 与
// `cancel_model_chat_completions` 的 `requestId` —— 它们是 camelCase，是全表仅有的两个例外。
//
// 嵌套载荷（`input` 内部、`change_context` 内部、`operations[]` 元素内部）的字段名由 Rust 侧
// struct 自己的 `#[serde(rename_all = "camelCase")]` 决定，**与命令的 rename_all 无关**，
// 一律 camelCase。最容易踩的是 `write_workspace_file`：顶层键 `change_context` 是 snake_case，
// 它的值里却是 `changeId` / `sessionId` / `runId` / `toolCallId`。逐条核对过，无第三种情况。
//
// 【`undefined` 陷阱：不要用 `'key' in args` 判存在】
// core 的 `toTauriInput` 是整份对象字面量返回，可选项没有值时键**存在且为 undefined**。
// 进程内注入（CLI / sidecar）时这些键原样到达 handler；走 HTTP 时 `JSON.stringify` 会把它们
// 丢掉。同一份入参在两种传输下的**键集合不同**，所以判存在只能看值（`args.x !== undefined`），
// 用 `in` 会写出「本地能跑、部署到 server 上行为变了」的 bug。
//
// 每条命令的权威来源都标在注释里（Rust 签名 + TS 调用点），改之前先核对那两处。
// 多条命令共用的嵌套载荷（变更上下文、补丁操作、MCP 实现信息）在 commandPayloads.ts。

import type { NodeHostCommandName } from './commandNames'
import type {
  McpImplementationInfoArgs,
  WorkspaceChangeContextArgs,
  WorkspacePatchOperationArgs,
} from './commandPayloads'

/**
 * 命令名 → 入参形状。`get_user_home_dir` / `mcp_config_read` 无参，写成 `undefined`：
 * 它们的调用点是 `invoke('get_user_home_dir')`，第二个实参根本不传。
 */
export interface NodeHostCommandArgs {
  // ── workspace/read ── Rust: workspace_read.rs（4 条全带 rename_all = snake_case）
  //    TS: agent-core/src/runtime/workspaceRead.ts 的 toTauriReadInput / …RunIndexPageInput /
  //    …ListInput / …SearchInput
  read_workspace_file: {
    path: string
    max_bytes?: number
    offset?: number
    start_line?: number
    line_count?: number
    workspace_root?: string
    /** 唯一允许越出 workspace_root 的开关；用户级 skills 扫描靠它读主目录下的文件。 */
    allow_external_paths?: boolean
  }
  read_workspace_run_index_page: {
    cursor?: string
    max_records?: number
    workspace_root?: string
  }
  list_workspace_files: {
    path?: string
    recursive?: boolean
    max_entries?: number
    include_hidden?: boolean
    workspace_root?: string
    allow_external_paths?: boolean
  }
  /** 按**文件名**匹配（内容检索是 rg_search_workspace）。 */
  search_workspace_files: {
    query: string
    path?: string
    glob?: string
    max_matches?: number
    workspace_root?: string
    allow_external_paths?: boolean
  }

  // ── workspace/write ── Rust: workspace_write.rs；TS: runtime/workspaceWrite.ts 的 toTauriInput
  write_workspace_file: {
    path: string
    content: string
    /** 'overwrite' | 'append' | 'create'；Rust 侧收 String 后自校验，不是闭合 enum。 */
    mode?: string
    expected_old_content?: string
    expected_content_hash?: string
    create_dirs?: boolean
    max_bytes?: number
    exclusive_path_lock?: boolean
    workspace_root?: string
    encoding?: string
    executable?: boolean
    dry_run?: boolean
    change_context?: WorkspaceChangeContextArgs
    /** 只用于日志关联，不影响写入语义；core 侧恒会传（缺省时自己造一个）。 */
    diagnostic_operation_id?: string
  }

  // ── workspace/patch ── Rust: workspace_patch.rs；TS: runtime/workspacePatch.ts
  apply_workspace_patch: {
    operations: readonly WorkspacePatchOperationArgs[]
    dry_run?: boolean
    workspace_root?: string
    change_context?: WorkspaceChangeContextArgs
    diagnostic_operation_id?: string
  }

  // ── workspace/change ── Rust: workspace_change_journal.rs；TS: runtime/workspaceChange.ts
  /** `change_set_id` 与 `change_set_ids` 二选一：单笔回滚 vs 批量回滚。 */
  revert_workspace_change: {
    change_set_id?: string
    change_set_ids?: readonly string[]
    dry_run?: boolean
    workspace_root?: string
  }

  // ── workspace/delete ── Rust: workspace_delete.rs；TS: runtime/workspaceDelete.ts
  delete_workspace_path: {
    path: string
    recursive?: boolean
    workspace_root?: string
    change_context?: WorkspaceChangeContextArgs
  }

  // ── workspace/pathOps ── Rust: workspace_path_ops.rs；TS: runtime/workspacePathOperation.ts
  //    两条命令入参完全一致：core 侧是同一个 operate() 用 `${operation}_workspace_path` 拼名字。
  copy_workspace_path: {
    source: string
    destination: string
    workspace_root?: string
    change_context?: WorkspaceChangeContextArgs
  }
  move_workspace_path: NodeHostCommandArgs['copy_workspace_path']

  // ── workspace/git ── Rust: workspace_git.rs；TS: runtime/workspaceGit.ts
  get_workspace_diff: {
    paths?: readonly string[]
    staged?: boolean
    base?: string
    max_diff_chars?: number
    include_stat?: boolean
    workspace_root?: string
  }

  // ── workspace/rg ── Rust: workspace_rg.rs；TS: runtime/workspaceRg.ts
  rg_search_workspace: {
    query: string
    path?: string
    regex?: boolean
    case_sensitive?: boolean
    globs?: readonly string[]
    context_lines?: number
    max_matches?: number
    workspace_root?: string
    allow_external_paths?: boolean
  }

  // ── workspace/task ── Rust: workspace_task.rs；TS: runtime/workspaceTask.ts
  run_workspace_task: {
    kind: string
    timeout_ms?: number
    max_output_chars?: number
    workspace_root?: string
  }

  // ── shell ── Rust: shell.rs；TS: runtime/shellCommand.ts
  run_shell_command: {
    /**
     * `'macos' | 'linux' | 'windows'`——core 的 `ShellPlatform`（`tools/types.ts`），**不是**
     * Node 的 `process.platform`（那套是 `darwin` / `win32`）。由 core 侧的 `detectHostPlatform()`
     * 在**调用方**探测后传下来，不是宿主自己判断。
     *
     * 【N3 记的一处隐患】这个「调用方探测」的前提在 server 宿主下不成立：浏览器在 macOS、
     * 服务端在 Linux 时，宿主会稳定回 `platform mismatch` 而一条命令都跑不了。见 S5 卡。
     */
    platform: string
    command: string
    cwd?: string
    timeout_ms?: number
    max_output_chars?: number
    env?: Record<string, string>
  }

  // ── mcp ── Rust: mcp.rs + mcp_types.rs；TS: apps/web/src/mcp/tauriStdioConnector.ts
  //    四条都是**无 rename_all** 的命令，顶层只有一个 `input`，其内部字段全 camelCase。
  //    `session_token` 是宿主侧的会话身份：连上之后每次调用都要带，用来挡住陈旧连接的复用。
  mcp_connect: {
    input: {
      serverId: string
      sessionToken: string
      command: string
      args?: readonly string[]
      cwd?: string
      env?: Record<string, string>
      requestTimeoutMs?: number
      protocolVersion?: string
      clientInfo?: McpImplementationInfoArgs
    }
  }
  mcp_list_tools: {
    input: {
      serverId: string
      sessionToken: string
      cursor?: string
      allPages?: boolean
      maxPages?: number
      timeoutMs?: number
    }
  }
  mcp_call_tool: {
    input: {
      serverId: string
      sessionToken: string
      name: string
      /** 注意键名就叫 `arguments`（MCP 协议用词），不是 `args`。 */
      arguments?: Record<string, unknown>
      meta?: Record<string, unknown>
      timeoutMs?: number
    }
  }
  mcp_disconnect: {
    input: { serverId: string; sessionToken: string; gracePeriodMs?: number }
  }

  // ── model ── Rust: model_proxy.rs / model_credentials.rs；
  //    TS: apps/web/src/modelTransport/tauriModelTransport.ts、apps/web/src/settings/
  //    modelCredentialHost.ts
  /**
   * 流式模型请求。桌面侧签名还有第三个参数 `events: Channel<ModelProxyEvent>`——那是 Tauri 的
   * 反向通道，**不是 JSON 入参**，所以不在本类型里。Node 宿主怎么把响应流送回调用方是
   * `events` 域要解决的事（HTTP 那条路上大概率是 SSE / chunked），`HostInvoke` 的
   * `(cmd, args) => Promise<T>` 签名本身装不下它。
   */
  model_provider_request: { input: { target: unknown; body: unknown; requestId: string } }
  /** 唯一的 camelCase 顶层参数之一（Rust 侧 `request_id`，命令没有 rename_all）。 */
  cancel_model_provider_request: { requestId: string }
  /** 旧渲染层兼容命令，当前无 TS 调用方；同样带 Channel 反向通道。 */
  model_chat_completions: { input: { provider: string; body: string; requestId: string } }
  /** 唯一的 camelCase 顶层参数之二。 */
  cancel_model_chat_completions: { requestId: string }
  /** `provider` 取 'deepseek' | 'glm' | 'kimi'，`scope` 取 'default' | 'cn'（Rust 侧 lowercase）。 */
  model_credential_status: { provider: string; scope?: string }
  /** 响应里**从不**回传 Key 值，只回 configured 与来源——这条契约在 Node 宿主也必须保住。 */
  model_credential_set: { input: { provider: string; scope?: string; apiKey: string } }
  model_credential_delete: { provider: string; scope?: string }

  // ── config ── Rust: mcp_config.rs / user_paths.rs；
  //    TS: apps/web/src/mcp/tauriMcpConfigStorage.ts、toolNameCacheStorage.ts、
  //    agent-core/src/runtime/userSkillsRoot.ts
  /** 无参。返回 `~/.webAgent/config.json` 的 `mcp` 段。 */
  mcp_config_read: undefined
  /** patch 与现有 `mcp` 段做合并，值为 `null` 的键表示删除——不是整段覆盖。 */
  mcp_config_write: { patch: Record<string, unknown> }
  /**
   * 无参。桌面侧从 Tauri 的 path API 取；Node 宿主取 `os.homedir()`。
   *
   * 调用点 `runtime/userSkillsRoot.ts` 随后会把这个值当作**同一次桥调用**的 confinement 根
   * 传回来（`workspace_root: <home>` + `allow_external_paths: true`），所以它必须和文件读取
   * 命令指的是同一台机器上的同一个主目录。这也是本卡明确拒绝把主目录塞进 `/api/health` 的
   * 原因：那会让「主目录是什么」有两个权威，而两处漂移时只表现为 skills 扫不到。
   */
  get_user_home_dir: undefined
}

// 编译期穷举：本表与 commandNames.ts 的全集必须**双向**一致。
// 单向不够——只查「每条命令都有入参形状」时，本表里留一条已经删掉的陈旧命令没人会发现；
// 只查「本表没有多余键」时，新增命令忘了写入参形状同样静默。两条都在，`pnpm build` 才拦得住。
// 违反时报的是 `Type 'X' does not satisfy the constraint 'Y'`，X/Y 就是差集，一眼能看出漏了谁。
type AssertExtends<Subset extends Superset, Superset> = Subset

type _EveryCommandHasArgs = AssertExtends<NodeHostCommandName, keyof NodeHostCommandArgs>
type _EveryArgsEntryIsACommand = AssertExtends<keyof NodeHostCommandArgs, NodeHostCommandName>
