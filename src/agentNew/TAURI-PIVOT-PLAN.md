# agentNew Tauri-Primary 转向计划：让工具变「真」

> 架构师工作法：主会话不写实现码，只维护本文 / 派活 / 验收 / codex review。
> 决策（2026-07）：**Tauri = 唯一产品目标 + 能力基准；web 降级为 dev 预览**。前端 99% 平台无关，同一份代码两处跑；转向 ≠ 删 web，而是不再把「浏览器沙盒里的 agent」当最终形态。
> 缘由：tools 三问（①没隔离 ②没抽象 ③没互调）里的**隔离**在 web 里无解（浏览器无进程/沙盒边界）；真实 fs/shell/子进程/MCP/无 CORS 网络只有 Rust 侧给。现状已半程指向 Tauri——`src-tauri/src/shell.rs::run_shell_command` 已是生产级真实 shell 执行器（超时/截断/进程组 kill/跨平台/stdin null），但前端 8 个工具全 `internal`/`browser`，**没有一个 `server`，ToolContext 也没有 invoke Rust 的口子**。本计划把这条缝接上。
> 沿用既有契约（每会话 store C3 / 不可变 C4 / ghost+stale 守卫 / UI 只读 atom+调命令 U1/U2 / 单测先行 / 一文件一职责 C9 / tool 只碰 ctx）。

---

## §1 转向设计契约

| # | 契约 |
|---|------|
| TP1 | **平台探测复用 `isTauri()`**，不新造判据。持久化 env-select 已在用它（`main.tsx`）；本轮 invoke 桥、manifest 降级共用同一个真值来源。 |
| TP2 | **invoke 单一入口**：前端调 Rust 只经 `ToolContext.invoke(command, args)` 一个口。工具**禁止**直接 `import '@tauri-apps/api'`（对齐「工具只碰 ctx」）。web 下 `invoke` 返回 `{ ok:false, error:'unavailable-on-web' }`，绝不崩、绝不抛（除 AbortError）。Tauri 下走 `@tauri-apps/api/core` 的 `invoke`（动态 import 代码分割，web 包不含它）。 |
| TP3 | **`runtime:'server'` 工具在 web 下不进 manifest**：`listToolSummaries()` 按 `isTauri()` 过滤掉 server 工具，model 根本看不到 → 不会去调一个必然失败的工具。Tauri 下才出现。（web dev 预览 = 功能子集，这是转向的既定含义。） |
| TP4 | **安全边界**：server 工具的真实副作用（shell 执行、写文件）默认信任本机 + 依赖 Rust 侧已有的输出/超时上限；**用户确认 UI 后置为独立阶段 S4**，不在首个闭环里做。危险度写进各工具 `.md` 的「注意」。 |
| TP5 | **单测策略**：vitest 仍在 jsdom（web）跑——`invoke` 走 mock（stub `isTauri`→false 验降级；或注入 fake invoke 验参数编排）。server 工具的**纯逻辑**（取参/校验/结果整形/降级分支）单测覆盖；**真实执行**留 Tauri 手测（`npm run tauri dev`）。不为跑真 shell 引 e2e。 |
| TP6 | **Rust command 契约对齐**：`invoke` 的 command 名 + 参数形状必须与 `src-tauri` 的 `#[tauri::command]` 签名逐字对齐（`run_shell_command` 用 `rename_all="snake_case"`，参数 `platform/command/cwd/timeout_ms/max_output_chars/env`）。新增 server 能力 = 先加 Rust command + 注册进 `invoke_handler` + capabilities 放行，再接前端工具。 |

---

## §2 阶段与依赖

> **执行校准（2026-07-02）**：动手时发现 S1/S2 设想的「从零造 invoke 桥 + 第一个 shell 工具」**其实已作为历史欠账存在**（上一会话 context 断在提交前，从未 review/commit）——底层 `runtime/{shellCommand,workspace*}.ts` 已各自 `invoke`+`isTauri()` 降级，`ctx` 已挂 `runShell`/`readWorkspaceFile`/… 语义方法（比通用 `ctx.invoke` 更强类型），工具层已铺 shell×3 + 文件族 6 个。因此本轮实际路径 = **TP3 收口 + 把这批欠账 review 干净**，S1/S2 就地并入 S1'。

**S1' — TP3 manifest 环境降级 + runtime 标记修正 ✅ 完成**
- 9 个依赖 Tauri 的工具 `runtime:'internal' → 'server'`（shell×3 + read/write/list/search/apply-patch/git-diff）；internal 留给 skill_search/skill_read/ask_user_question，browser 留给 browser_action/save_file。
- `modelTurn.ts`：`buildTurnTools(visible, isTauri)` + 谓词 `isToolVisible(runtime, isTauri)`，同时过滤 `request_tool_schema` enum 与 visible 展开；`modelRun.ts` 注入 `isTauri()`。
- 新增 `runtime/modelTurn.test.ts`（web 滤 server / Tauri 保留 / visible 过滤 / 元工具恒在场）。
- 验收：build + vitest 297 全绿；codex review **判 TP3 干净**。

**S2' — 历史欠账 workspace 工具的 codex review 收口 ✅ 完成（4 轮迭代）**
- 🟥 P1 安全：`workspace_root` 弃用不可控 process cwd → `workspace_common::resolve_workspace_root`（显式优先 → `git rev-parse --show-toplevel` 兜底 → 拒文件系统根）；confine 落实 canonical + `starts_with(root)`。
- 🟨 健壮性：git diff 流式 capped read（弃整块 `.output()`，达上限 kill）；search 加 20k 扫描预算 + 目录排除。
- 🟨 正确性：apply_patch 堵 delete+add 绕过 overwrite 守卫（`initial.is_some()` 也拒）；git status 按 pathspec 收窄。
- 🟨 git 全面加固：所有 git 子进程经 `git_command` 单入口——`--no-ext-diff --no-textconv`/`-c diff.external=`/`GIT_EXTERNAL_DIFF=""`（禁外部 diff）、`GIT_LITERAL_PATHSPECS=1`、`GIT_OPTIONAL_LOCKS=0`（真只读）。
- 🟨 一致性：write_file 返回 workspace 相对路径，不泄漏绝对路径。
- 新增首个 Rust 测试模块（workspace_patch/git 共 5 例）；验收 cargo build 0/0 + cargo test 5 passed + npm 297。codex review 迭代到只剩收敛后的 cosmetic，止于纪律（不无限循环）。

**S3 — 文档收口 ✅ 完成**
- `tools/TOOLS-SPEC.md`：修正 `server` 语义（§2/§13 不再说「只留标记」）、§15 安全约束补 root/git 加固/守卫、新增 §16（TP1–6 要点）。
- 本文校准（本节）。

**S4（后续，未排期）** — 安全确认 UI（危险 server 工具执行前弹确认）；workspace root 的「用户选目录 + session 绑定」完整链路（桥已预留 `workspaceRoot` 参数）；真 MCP client。批量生成工具从这里起量（§10 模板 + server 变体模板）。

---

## §3 非目标（本轮不做）
- 不删 web 降级路径 / IndexedDB driver（TP1 双轨零成本，dev 预览要用）。
- 不做确认 UI / 权限系统（S4）。
- 不批量铺工具（先把一条 server 链路跑通验证模板，再谈量）。
