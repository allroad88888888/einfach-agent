// 宿主命令全集：有哪些命令、各属哪一域
// ---------------------------------------------------------------------------
// 这张表是 N 线 25 张卡共用的施工图，也是「宿主一共有哪些命令」的**唯一权威**。
//
// 权威从哪来：`apps/desktop/src/lib.rs` 的
// `invoke_handler(tauri::generate_handler![...])` 目前登记了 28 条 `#[tauri::command]`。
// core 里 13 个 runtime 模块经 `HostInvoke` 发出的命令名，加上 apps/web 的 mcp / model /
// settings 装配层直接发出的命令名，合起来正好是这 28 条。换句话说：Node 宿主要做到「能力
// 完整」，要兑现的就是这 28 条，一条不多、一条不少。commandNames.test.ts 逐字比对 lib.rs 的
// 登记列表，防止两边悄悄漂移——Rust 侧新增一条而这里没登记，后果是 Node 宿主永远不知道该
// 实现它，而症状只是某个功能「在浏览器版里没反应」。
//
// **`sqlite` 域是这条对照之外的**（P2 新增，全表因此是 30 条）：桌面侧的会话与 trace 持久化走
// `@tauri-apps/plugin-sql`，那是 Tauri **插件**暴露的命令，从来不在 lib.rs 的 `generate_handler!`
// 里。它们没有 Rust 对应物可比对，所以测试把这一域从两边比对里排除掉，而不是放宽比对口径——
// 放宽之后 Rust 侧真的漂移了也不会有人知道。将来再有这类「Node 独有」的域，同样在测试里点名。
//
// 为什么名字要单独成一张穷举表，而不是散在各域实现里：
//   · 分发要能区分「这条命令还没实现」和「这个名字根本不存在」。前者是施工进度，调用方等
//     后续卡落地即可；后者是调用方拼错了名字或用了废弃名，永远等不到。只有一张穷举表能把
//     这两件事分开，见 createNodeHostInvoke.ts 的 NodeHostCommandError。
//   · apps/server（S 线）要按这张表挂 `POST /api/invoke/:command`。它需要在一个域实现都还
//     没有的时候就知道合法名字集合，否则只能把任意路径都转发进路由表。
//
// **入参形状不在本文件，在 commandArgs.ts**：这里回答「有哪些命令」，那里回答「每条命令收
// 什么」。两件事、两个文件——合起来会顶破仓库的 300 行硬上限，而且改入参形状的人和改命令
// 集合的人从来不是同一次改动。

/**
 * 域 → 该域负责的命令名。**键就是 `src/` 下的实现目录名**（`workspace/read` ↔
 * `src/workspace/read/`），所以这张表同时也是目录结构的规格说明；后续卡新建域目录时按这里的
 * 键来建，不要各自发挥。
 *
 * 有两个域在这张表里**没有命令**，因为它们不对应任何一次「问一句、答一个 JSON」的调用：
 *   · `workspace/common` —— 工作区禁闭（confinement）与变更日志（change journal）的共用实现，
 *     被 read/write/patch/delete/pathOps 等域共同依赖。它是零件，不是命令。
 *   · `events` —— 桌面侧的两种「反向通道」在 Node 宿主里的替身：`model_provider_request` /
 *     `model_chat_completions` 的 `events: Channel<...>` 入参，以及 `mcp_connect` 之后 Rust 侧
 *     用 `emit` 推、前端用 `@tauri-apps/api/event` 的 `listen` 收的 stdio 生命周期事件。
 *     两者都不是「一次调用一个 JSON 返回值」，`HostInvoke` 的签名装不下，需要独立的传输设计。
 */
export const NODE_HOST_COMMANDS_BY_DOMAIN = {
  // 工作区读取面。四条命令共用同一套路径禁闭（`workspace_root` + `allow_external_paths`）。
  'workspace/read': [
    'read_workspace_file',
    'read_workspace_run_index_page',
    'list_workspace_files',
    'search_workspace_files',
  ],
  // 整文件写入。入参最宽的一条（14 个顶层键），带乐观锁（expected_old_content /
  // expected_content_hash）与独占路径锁。
  'workspace/write': ['write_workspace_file'],
  // 结构化补丁：一次调用里一批 add_file / delete_file / replace / overwrite_file 操作，
  // 要么全成要么全不成。
  'workspace/patch': ['apply_workspace_patch'],
  // 变更日志回滚。write / patch / delete / pathOps 通过 `change_context` 记账，这条负责回退。
  'workspace/change': ['revert_workspace_change'],
  'workspace/delete': ['delete_workspace_path'],
  // 复制与移动共用一份实现，命令名由 `${operation}_workspace_path` 拼出（见 core 的
  // runtime/workspacePathOperation.ts）——两条命令的入参形状完全一致。
  'workspace/pathOps': ['copy_workspace_path', 'move_workspace_path'],
  'workspace/git': ['get_workspace_diff'],
  // ripgrep 内容检索。与 workspace/read 的 search_workspace_files 不同：那条按**文件名**匹配，
  // 这条按**文件内容**匹配，并依赖外部 `rg` 可执行文件。
  'workspace/rg': ['rg_search_workspace'],
  // 预置任务（构建/测试之类按 kind 派发的固定命令行），与自由 shell 分开。
  'workspace/task': ['run_workspace_task'],
  'shell': ['run_shell_command'],
  // MCP stdio 子进程的生命周期与 JSON-RPC 转发。连上之后还有一路 emit/listen 事件，见上面
  // `events` 域的说明。
  'mcp': ['mcp_connect', 'mcp_list_tools', 'mcp_call_tool', 'mcp_disconnect'],
  // 模型域两件事：受限传输（前四条，带流式反向通道）与凭证读写（后三条，响应里**从不**含
  // Key 值，只含 configured 布尔与来源）。`model_chat_completions` /
  // `cancel_model_chat_completions` 是 Rust 侧给旧渲染层留的兼容命令，当前**没有任何 TS 调用
  // 方**（全仓 grep 为零）——登记在册是因为它们确实在 lib.rs 里，但实现优先级最低。
  'model': [
    'model_provider_request',
    'cancel_model_provider_request',
    'model_chat_completions',
    'cancel_model_chat_completions',
    'model_credential_status',
    'model_credential_set',
    'model_credential_delete',
  ],
  // `~/.webAgent/config.json` 与主目录解析。mcp_config_* 只是这份 JSON 里 `mcp` 段的读写，
  // 与 `mcp` 域的子进程管理是两件事（Rust 侧同样分成 mcp_config.rs 与 mcp.rs）。
  // get_user_home_dir 归这里：配置文件与用户级 skills 目录都以主目录为根。
  'config': ['mcp_config_read', 'mcp_config_write', 'get_user_home_dir'],
  // **本仓库 `#[tauri::command]` 之外新增的一域**（P2）：桌面侧的会话与 trace 持久化走
  // `@tauri-apps/plugin-sql`（`packages/persistence-sqlite`、`packages/observability-sqlite`），
  // 那是 Tauri 插件暴露的命令。Node 宿主给出等价能力，命令名由 P2 自定并登记于此。
  // 两条命令与 P1 的 `SqlExecutor` 一一对应，按「语句有没有返回行」分而不是按读写分——
  // PRAGMA 会回一行当前值，因此走 `sqlite_select`。刻意**没有** `sqlite_execute_batch`：
  // 一次调用 = 一条自包含语句，判据见 core 的 state/persistence/sqlTransport.ts 文件头。
  'sqlite': ['sqlite_execute', 'sqlite_select'],
} as const

/** 域名 = `src/` 下的实现目录名。 */
export type NodeHostCommandDomain = keyof typeof NODE_HOST_COMMANDS_BY_DOMAIN

/**
 * 30 条命令名的字面量联合（28 条对应 Rust 命令 + sqlite 域 2 条）。**从表里推导而不是手写
 * 第二份**——手写会立刻出现「表里有、类型里没有」的第二权威，而两份表不一致时 TypeScript
 * 一声不吭。
 */
export type NodeHostCommandName =
  (typeof NODE_HOST_COMMANDS_BY_DOMAIN)[NodeHostCommandDomain][number]

/** 全集的运行时形态（S 线挂路由、测试做穷举都要它）。顺序按域分组，与上表一致。 */
export const NODE_HOST_COMMAND_NAMES: readonly NodeHostCommandName[] = Object.freeze(
  Object.values(NODE_HOST_COMMANDS_BY_DOMAIN).flat() as NodeHostCommandName[],
)

const commandNameSet: ReadonlySet<string> = new Set(NODE_HOST_COMMAND_NAMES)

/**
 * 名字是否在全集内。
 *
 * 分发时**必须**先过这道判断再查路由表：直接查表拿不到 handler 时，「没实现」和「名字不存在」
 * 会塌成同一个结果，而这两者要给调用方的答复完全不同（见 createNodeHostInvoke.ts）。
 */
export function isNodeHostCommandName(value: string): value is NodeHostCommandName {
  return commandNameSet.has(value)
}
