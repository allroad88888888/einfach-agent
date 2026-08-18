# Node 宿主与 Web 自托管 Issue 树

## 目标

把浏览器版从「残废预览」做成能力完整的本地自托管应用：后端**一份 Node/TS 能力实现**
（`packages/host-node`），服务浏览器、CLI、以及最终退成套壳的 Tauri 三个前壳，经 npm 分发
（`npx web-agent`），**不需要任何代码签名证书**。

动机是分发成本：桌面版发布要 Apple Developer ID 与 Windows code-signing 证书
（见 [release-signing.md](release-signing.md) 的九个 Secret）。Web 自托管绕开整条链路。

终局形态：

```text
                    ┌─ 浏览器 ────── HTTP ─────┐
core (TS，不变) ──▶  ├─ CLI ───────── 进程内 ────┼──▶ packages/host-node ──▶ 系统调用
  configureHostInvoke └─ Tauri 套壳 ── sidecar ──┘      （一份能力实现）
```

## 树概览

```text
H  core host bridge 抽象        H1 → H2/H3/H4 → H5 → H6
N  host-node 薄包装区           N1 → N2 → N3/N4/N5/N6/N7 → N8 ★CLI 完整
W  host-node 真逻辑区           W1..W15 → W16/W17 对拍
S  server HTTP 外壳             S1 → S2/S3 → S4
B  前端 server 宿主装配          B1 → B2 → B3 → B4 ★浏览器 fs/shell 可用
M  模型代理                     M1 → M2/M4 → M3 → M5 ★浏览器完整对话
C  MCP 与事件通道               C1/C2 → C3 → C4
P  持久化收敛                   P1 → P2 → P3 → P4
D  分发                        D1 → D2 → D3 → D4
T  Tauri 退成套壳               T1 → T2 → T3 → T4
未决                           目录选择器 / 对拍覆盖下限 / 多 workspace 切换
```

**MVP 路径 = H + N + W1–W15 + S + B + M**（约 44 卡）。到 M5 浏览器版即可用；
C/P/D/T 是增强与收尾，可后置。

## 并行规则

- 分支内按依赖串行，分支间凡改动面不重叠即可并行。
- H 线必须整条做完再开 N8/B 线：它改的是 core 的注入点，中途状态下没有宿主能提供 invoke。
- W 线各卡改动面天然按目录隔离（`workspace/read/`、`workspace/write/`…），可高度并行，
  但都依赖 N2 的路径底座。
- 同时在途控制在 3–4 卡，验收吞吐是瓶颈。

## 现状事实

写卡前核实过的代码事实，是所有卡的共同依据。

**core 侧的 Tauri 耦合点是 13 个文件，形状统一。**
`packages/agent-core/src/runtime/` 下的 `workspaceRead / workspaceWrite / workspacePatch /
workspaceDelete / workspacePathOperation / workspaceRg / workspaceGit / workspaceChange /
workspaceTask / shellCommand / projectSkillsBridge / modelTurnPrefix / workspaceDialog`
各自持有同一段：

```ts
if (!isTauriHost()) return fail('… is only available in the Tauri desktop runtime')
const invoke = await loadTauriInvoke()
const raw = await invoke<unknown>('<command_name>', toTauriInput(input))
```

两个导出都来自 `runtime/hostTauri.ts`（61 行）。**浏览器与 CLI 因此都拿不到文件与 shell 能力。**

**Rust 侧共 27 个 `#[tauri::command]`，非测试实现 12336 行。**
关键：`workspace_*` 与 `shell*` **完全不 `use tauri`**。全仓只有 9 个 Rust 文件引用 tauri，
用法只有两类——`AppHandle` 取 `home_dir()` / `app_data_dir()`，`State<T>` 取全局单例
（`McpManager`、`ModelRequestCanceller`）。

**Node 等价实现约 4700 行**，其中真逻辑约 2550 行（read / write / patch / change），
其余是薄包装。分区实测：

| 区域 | Rust 实现 | Node 估算 | 性质 |
| --- | ---: | ---: | --- |
| MCP stdio | 1964 | ~300 | 协议编排已在 TS（`tools/mcp` 5178 行），Rust 只做 stdio 传输 |
| model proxy | 1250 | ~250 | HTTP 转发；不需要 Channel 编解码 |
| git / rg / task | 1560 | ~600 | 全是 spawn 外部命令 + 解析输出 |
| shell | 618 | ~300 | `child_process` 比 Rust 短 |
| delete / pathOps / common | 1152 | ~550 | 薄 IO 包装 |
| config store | 311 | ~150 | 读写 JSON |
| **workspace_write** | 2012 | ~900 | 写锁 / 限额 / atomic write |
| **workspace_read** | 1245 | ~550 | 分页 / 行寻址 / contentHash |
| **workspace_change** | 1181 | ~600 | journal + revert |
| **workspace_patch** | 965 | ~500 | patch 引擎 |

**流式只有两处，其余全是请求-响应。**
① 模型代理走 Tauri `Channel<ModelProxyEvent>`（`apps/web/src/modelTransport/tauriModelTransport.ts`）；
② MCP 走 Tauri `listen()` 收 `mcp-stdio-tools-changed` / `mcp-stdio-close`
（`apps/web/src/mcp/tauriStdioConnector.ts`）。shell / workspace 27 个命令里的其余部分逐个映射即可。

**Rust 测试面：3410 行测试文件 + 161 个测试函数。** 这是重写要接过来的账，也是对拍的素材源。
T 线之前 Rust 仍在，那段窗口期是唯一能双跑对拍的时机。

**`atomic_write` 的语义不能简化**（`apps/desktop/src/workspace_common.rs`）：
临时文件 → `sync_all` → **回填原文件权限位** → rename。少了权限回填，一次覆盖就会静默抹掉
脚本的可执行位。

**持久化现状**：桌面走 `@tauri-apps/plugin-sql` 的 SQLite，浏览器走 IndexedDB
（`apps/web/src/persistence/persistenceDrivers.ts` 按 `tauriHost` 二选一）。
套壳后的桌面版若不做 P 线会丢掉 SQLite。

**门禁三处要随新包同步**：`vite.config.ts` 的 `resolve.alias`、`tsconfig.app.json` 的 `paths`、
`scripts/check-boundaries.js` 的 `capabilityPackages` 数组。

---

## H · core host bridge 抽象

### H1 · 把 invoke 抽成可注入的 host bridge 契约

- **依赖**：—
- **改动面**：新建 `packages/agent-core/src/runtime/hostBridge.ts` 与 `hostBridge.test.ts`
- **判据**：导出 `HostInvoke` 类型、`configureHostInvoke(loader)`、`hasHostBridge()`、
  `loadHostInvoke()`。**注入的是 loader（`() => Promise<HostInvoke>`）不是已解析的 invoke**——
  装配层拿 invoke 本身是异步的，注入已解析值会让「工具在注入完成前执行」变成一个时序竞态。
  `hasHostBridge()` 判的是 loader 是否已登记，同步可答。loader 只解析一次并缓存
  （照抄 `hostTauri.ts` 的 `??=` 理由：并发首次调用时 Vitest mocker 有一路会拿到未替换的真模块）。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/hostBridge.test.ts`
- **模型**：opus
- **状态**：TODO

### H2 · workspace 读侧四模块改走 host bridge

- **依赖**：H1
- **改动面**：`packages/agent-core/src/runtime/` 的 `workspaceRead.ts`（5 处）、`workspaceRg.ts`、
  `workspaceGit.ts`、`workspaceTask.ts`
- **判据**：`isTauriHost()` → `hasHostBridge()`、`loadTauriInvoke()` → `loadHostInvoke()`，
  invoke 的 command 名与参数**逐字不变**。四个文件内 `hostTauri` 的 import 归零。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/workspaceRead` 与同目录 Rg/Git/Task 用例
- **模型**：sonnet
- **状态**：TODO

### H3 · workspace 写侧五模块改走 host bridge

- **依赖**：H1
- **改动面**：`packages/agent-core/src/runtime/` 的 `workspaceWrite.ts`、`workspacePatch.ts`、
  `workspaceDelete.ts`、`workspacePathOperation.ts`、`workspaceChange.ts`
- **判据**：同 H2；额外确认 `workspacePatch.ts` / `workspaceWrite.ts` 传给 observability 的参数未动。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/workspaceWrite.test.ts` 与
  `workspacePatch.timing.test.ts`
- **模型**：sonnet
- **状态**：TODO

### H4 · shell 与其余两模块改走 host bridge

- **依赖**：H1
- **改动面**：`packages/agent-core/src/runtime/` 的 `shellCommand.ts`、`projectSkillsBridge.ts`、
  `modelTurnPrefix.ts`
- **判据**：同 H2。`workspaceDialog.ts` **不在本卡范围**（它用的是 `@tauri-apps/plugin-dialog`
  而非 core invoke，归未决项）。跑 `pnpm exec vitest run packages/agent-core/src/runtime/shellCommand`
- **模型**：sonnet
- **状态**：TODO

### H5 · Tauri 装配层注入 invoke loader

- **依赖**：H2、H3、H4
- **改动面**：`apps/web/src/main.tsx`（tauri 分支）、`apps/web/src/test/setup.ts`（测试宿主注入）
- **判据**：桌面宿主下 `configureHostInvoke(() => loadTauriInvoke())` 在
  `registerStandardTools` 之后、任何工具可能执行之前完成。**这卡是 H 线的试金石**：
  跑 `pnpm exec vitest run packages/agent-core apps/web` 全绿 + `pnpm build`，
  桌面版行为与 H1 之前逐项一致
- **模型**：opus
- **状态**：TODO

### H6 · 宿主不可用文案去 Tauri 化

- **依赖**：H2、H3、H4
- **改动面**：H2–H4 涉及的 12 个文件里的 fail 文案
- **判据**：`grep -rn "only available in the Tauri desktop runtime" packages/agent-core/src` 归零，
  替换为「当前宿主未提供 workspace 桥」（用户可见文案保持中文）。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime` 并更新命中该文案的断言
- **模型**：sonnet
- **状态**：TODO

---

## N · host-node 薄包装区

### N1 · 建 host-node 包骨架与路由表契约

- **依赖**：H1
- **改动面**：新建 `packages/host-node/`（package.json、tsconfig、`src/createNodeHostInvoke.ts`、
  `src/commandNames.ts`）；同步 `vite.config.ts` 的 alias、`tsconfig.app.json` 的 paths、
  `scripts/check-boundaries.js` 的 `capabilityPackages`
- **判据**：`createNodeHostInvoke(options): HostInvoke` 返回一个按 command 名分发的路由表，
  未实现的命令返回明确的「未实现」而非静默失败。**包不依赖 `@web-agent/core` 的运行时**
  （只 import type），不含任何 HTTP。跑 `node scripts/check-boundaries.js` + `pnpm build`
- **模型**：opus
- **状态**：TODO

### N2 · workspace 路径底座与 atomic write

- **依赖**：N1
- **改动面**：`packages/host-node/src/workspace/common/`（路径解析、confinement 判定、
  `atomicWrite`、带上限的增量读）
- **判据**：对齐 `apps/desktop/src/workspace_common.rs`。三条必须有 colocated 测试：
  ① 越界路径（`../`、绝对路径、symlink 逃逸）被拒；
  ② `atomicWrite` 写完后**原文件权限位保留**（含可执行位）；
  ③ 增量读到上限即停，不把大输出全缓冲进内存。
  跑 `pnpm exec vitest run packages/host-node/src/workspace/common`
- **模型**：opus
- **状态**：TODO

### N3 · shell 执行

- **依赖**：N2
- **改动面**：`packages/host-node/src/shell/`
- **判据**：对齐 `apps/desktop/src/shell*.rs`（618 行）：平台 shell 选择、timeout、
  stdout/stderr 上限截断、后台进程登记与 wait/kill。命令 `run_shell_command` 的入参与返回
  逐字段对齐 core 的 `ShellCommandInput` / `ShellCommandResult`。
  跑 `pnpm exec vitest run packages/host-node/src/shell`
- **模型**：opus
- **状态**：TODO

### N4 · git diff

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/git/`
- **判据**：对齐 `apps/desktop/src/workspace_git*.rs`（594 行）。**参数白名单必须照搬**
  （`workspace_git_args.rs` 与 `workspace_git_args_tests.rs`）——它挡的是经 diff 参数注入
  任意 git 子命令。跑 `pnpm exec vitest run packages/host-node/src/workspace/git`
- **模型**：opus
- **状态**：TODO

### N5 · rg 搜索

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/rg/`
- **判据**：对齐 `apps/desktop/src/workspace_rg.rs`（486 行）：spawn `rg --json`、上下文行、
  `maxMatches` 上限与 truncated 标记、stderr 截断、`--max-filesize=1M`。rg 缺失时返回可读错误
  而非崩溃。跑 `pnpm exec vitest run packages/host-node/src/workspace/rg`
- **模型**：sonnet
- **状态**：TODO

### N6 · run workspace task

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/task/`
- **判据**：对齐 `apps/desktop/src/workspace_task.rs`（480 行）：按 kind 发现并执行
  测试/lint 命令、输出上限、退出码透传。跑 `pnpm exec vitest run packages/host-node/src/workspace/task`
- **模型**：sonnet
- **状态**：TODO

### N7 · 用户配置读写

- **依赖**：N1
- **改动面**：`packages/host-node/src/config/`
- **判据**：对齐 `web_agent_config_store.rs` + `web_agent_config_write.rs`：默认
  `~/.webAgent/config.json`；**新文件不存在时才**安全复制旧 `~/.web-agent/config.json`，
  新文件优先且旧文件保留；`WEB_AGENT_CONFIG_DIR` 只选目录、**不接受也不返回模型 Key**；
  设置覆盖目录时不触发迁移。Unix 下配置目录权限 0700。
  跑 `pnpm exec vitest run packages/host-node/src/config`
- **模型**：opus
- **状态**：TODO

### N8 · CLI 注入进程内 host

- **依赖**：H5、N3、N4、N5、N6、N7
- **改动面**：`apps/cli/src/runtime.ts`
- **判据**：**本线试金石**。`configureHostInvoke` 在 `registerStandardTools` 之后调用；
  `pnpm cli -p "列出当前目录下的文件并读取 package.json"` 真的返回文件内容，而不是
  「当前宿主未提供 workspace 桥」。跑 `pnpm exec vitest run apps/cli` + `pnpm build`
- **模型**：opus
- **状态**：TODO

---

## W · host-node 真逻辑区

所有 W 卡依赖 N2，彼此改动面按目录隔离，可高度并行。

### W1 · 文件读：字节分页与 contentHash

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/bytes*`
- **判据**：对齐 `workspace_read_bytes.rs` + `workspace_read_content.rs`：`offset` / `maxBytes` /
  `totalBytes` / `nextOffset` 语义逐字段一致；**`contentHash` 只在 offset 0 的首片返回，
  且截断时也返回**，8 MB 以上不返回。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W2 · 文件读：行寻址

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/lines*`
- **判据**：对齐 `workspace_read_lines.rs`：`startLine` / `lineCount` / `endLine` / `nextLine` /
  `totalLines`；`startLine` 与非零 `offset` 互斥的拒绝路径有测试。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W3 · 目录列举与文件名搜索

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/list*`、`search*`
- **判据**：对齐 `workspace_read_list.rs` + `workspace_read_search.rs`：`recursive` /
  `maxEntries` / `includeHidden`；**不递归进 symlink**。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### W4 · run index 分页读

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/runIndex*`
- **判据**：对齐 `workspace_read_run_index.rs`：JSONL 游标分页、`snapshot` 标识、`hasMore`。
  跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### W5 · 文件写：目标路径解析与限额

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/write/targetPath*`、`limits*`
- **判据**：对齐 `workspace_write_target_path.rs` + `workspace_write_limits.rs`。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W6 · 文件写：进程内与跨进程写锁

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/write/lock*`
- **判据**：对齐 `workspace_write_lock.rs`：进程内按目标路径的互斥表（含扫除阈值）+
  跨进程锁文件（`create_new` 抢占、token、心跳、stale 超时接管）。
  必须有「两个并发写同一路径被串行化」的测试。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W7 · 文件写：乐观守卫与主流水线

- **依赖**：W5、W6
- **改动面**：`packages/host-node/src/workspace/write/guard*`、`pipeline*`
- **判据**：对齐 `workspace_write_guard.rs` + `workspace_write_pipeline.rs`：
  read-verify-write，`contentHash` 不匹配时拒绝覆盖并返回可操作错误。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W8 · 文件写：base64 二进制写入

- **依赖**：W7
- **改动面**：`packages/host-node/src/workspace/write/base64*`
- **判据**：对齐 `workspace_write_base64.rs`：解码失败明确报错，不写出半个文件。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### W9 · 文件写：归档 compaction

- **依赖**：W7
- **改动面**：`packages/host-node/src/workspace/write/compaction*`
- **判据**：对齐 `workspace_write_compaction.rs`。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### W10 · 删除路径

- **依赖**：N2、W14
- **改动面**：`packages/host-node/src/workspace/delete/`
- **判据**：对齐 `workspace_delete.rs`（461 行）。删除是不可逆动作，**必须先进 change journal
  再执行**，否则 `revert_workspace_change` 拿不回来。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W11 · 复制与移动路径

- **依赖**：N2、W14
- **改动面**：`packages/host-node/src/workspace/pathOps/`
- **判据**：对齐 `workspace_path_ops.rs`：源/目标双向 confinement、目标已存在的处理、
  进 change journal。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### W12 · patch：路径解析与 stage

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/patch/path*`、`stage*`
- **判据**：对齐 `workspace_patch_path.rs` + `workspace_patch_stage.rs`。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W13 · patch：应用流水线与限额

- **依赖**：W12、W14
- **改动面**：`packages/host-node/src/workspace/patch/pipeline*`、`fs*`、`limits*`
- **判据**：对齐 `workspace_patch_pipeline.rs` + `workspace_patch_fs.rs` +
  `workspace_patch_limits.rs`：全部 hunk 成功才落盘，任一失败整体不写。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W14 · change journal：类型与写入

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/change/types*`、`prepare*`
- **判据**：对齐 `workspace_change_journal_types.rs` + `_prepare.rs`。journal 目录取
  Tauri 的 `app_data_dir()/workspace-changes` 同款路径，使套壳后与桌面版共用同一份日志。
  跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W15 · change journal：批次与 revert

- **依赖**：W14
- **改动面**：`packages/host-node/src/workspace/change/batch*`、`revert*`、`pathOps*`
- **判据**：对齐 `_batch.rs` + `_revert.rs` + `_path_ops.rs`：`dryRun` 语义、批次内顺序、
  部分失败的报告形态。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### W16 · Rust↔TS 对拍 fixture：patch 与 change journal

- **依赖**：W13、W15
- **改动面**：新建 `packages/host-node/fixtures/`（共享 JSON）+ 两侧的 fixture 驱动测试
- **判据**：**新范式卡，会被 W17 抄。** 从 Rust 的 `workspace_patch_*_tests.rs` 与
  `workspace_change_journal_batch_tests.rs` 抽出输入/期望为语言无关的 JSON，
  Rust 与 TS 各写一个驱动器跑同一组。两侧全绿；故意改一处 TS 实现能让对拍变红
  （证明它真在比对，不是空跑）。跑 `pnpm exec vitest run packages/host-node` +
  `cargo test --manifest-path apps/desktop/Cargo.toml`
- **模型**：opus
- **状态**：TODO

### W17 · 对拍 fixture 扩到写锁与读限额

- **依赖**：W16
- **改动面**：`packages/host-node/fixtures/` 增量 + 两侧驱动器
- **判据**：照 W16 的范式覆盖 `workspace_write_*_tests.rs` 与
  `workspace_read_*_tests.rs` 的限额/边界用例。两侧全绿
- **模型**：sonnet
- **状态**：TODO

---

## S · server HTTP 外壳

### S1 · server 包骨架、health 与静态托管

- **依赖**：N1
- **改动面**：新建 `apps/server/`；同步 `vite.config.ts` alias 与 `tsconfig.app.json` paths
- **判据**：`GET /api/health` 返回版本与宿主标识；`GET /*` 服务 `apps/web/dist`（缺失时给出
  可读提示而不是 404 裸页）。跑 `pnpm exec vitest run apps/server` + `node scripts/check-boundaries.js`
- **模型**：opus
- **状态**：TODO

### S2 · token 认证、Origin 校验与 loopback 绑定

- **依赖**：S1
- **改动面**：`apps/server/src/auth*`
- **判据**：**安全边界卡。** 默认只绑 `127.0.0.1`（复用
  `scripts/model-preview-relay.ts` 的 `isLoopbackAddress` 判据）；每次启动生成随机 token，
  `/api/*` 全部校验；校验 `Origin` 拒绝跨站。必须有测试证明：**无 token 的请求被拒**
  ——否则本机任何网页里的 JS 都能 POST 一条 `run_shell_command`。
  跑 `pnpm exec vitest run apps/server/src/auth`
- **模型**：opus
- **状态**：TODO

### S3 · `/api/invoke/:command` 接 host-node 路由表

- **依赖**：S1、N1
- **改动面**：`apps/server/src/invokeRoute*`
- **判据**：body 即 args JSON，逐字透传给 `createNodeHostInvoke` 的路由表；未知 command
  返回 404 而非 500。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### S4 · 启动 CLI：端口选择、URL 打印、打开浏览器

- **依赖**：S2、S3
- **改动面**：`apps/server/src/main.ts`、根 `package.json` 加脚本
- **判据**：`pnpm server` 打印带 token 的完整 URL；端口被占时自动换端口而非崩溃；
  `--no-open` 可关闭自动打开。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

---

## B · 前端 server 宿主装配

### B1 · 宿主探测三态化

- **依赖**：S1
- **改动面**：新建 `apps/web/src/host/resolveHost.ts` 与其测试
- **判据**：返回 `'tauri' | 'server' | 'static'`。顺序：`isTauri()` → `GET /api/health` 成功 →
  `static`。探测失败必须落到 `static` 而不是挂起首屏。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### B2 · httpInvoke 实现

- **依赖**：B1、S3
- **改动面**：新建 `apps/web/src/host/serverInvoke.ts` 与其测试
- **判据**：签名与 `HostInvoke` 一致；token 从 URL query 取一次后从地址栏清掉
  （避免进浏览器历史与 Referer）；HTTP 错误映射成与 Tauri invoke 同形状的 reject。跑该目录 vitest
- **模型**：sonnet
- **状态**：TODO

### B3 · main.tsx 按宿主分发并拆分到 300 行内

- **依赖**：B1、B2、H5
- **改动面**：`apps/web/src/main.tsx`（当前 224 行）、新增 `apps/web/src/host/` 下的装配模块
- **判据**：三宿主各自的 invoke / 持久化 / 观测 driver 选择收口到 `host/`；
  `wc -l apps/web/src/main.tsx` ≤ 300。**不许为凑行数把强内聚的装配序列打碎**——
  按「宿主」这一个职责切。跑 `pnpm exec vitest run apps/web` + `pnpm build`
- **模型**：opus
- **状态**：TODO

### B4 · 端到端验收：浏览器里读写文件与跑 shell

- **依赖**：B3、N8
- **改动面**：无（验收卡）
- **判据**：**主会话亲自。** `pnpm server` 后浏览器实际完成一轮：列目录 → 读文件 →
  写文件 → 跑一条 shell 命令。截图或逐步记录留在 scratchpad
- **模型**：—（主会话亲自）
- **状态**：TODO

---

## M · 模型代理

### M1 · host-node 的 provider 请求转发

- **依赖**：N7
- **改动面**：`packages/host-node/src/model/`
- **判据**：对齐 `model_proxy*.rs` 的**端点白名单与 provider 路由**
  （`model_provider_route.rs`），Key 只从 N7 的配置读、**永不出现在返回体里**；
  上游流式响应原样透传；请求取消能真的中断上游。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### M2 · server 的流式模型端点

- **依赖**：M1、S2
- **改动面**：`apps/server/src/modelRoute*`
- **判据**：`POST /api/model/request` 直接返回流式 body（**不进 `/api/invoke/:command`
  的统一路由**）；客户端断开时上游请求被取消。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### M3 · 前端 serverModelTransport

- **依赖**：M2、B2
- **改动面**：新建 `apps/web/src/modelTransport/serverModelTransport.ts` 与其测试
- **判据**：产出与 `createTauriModelFetch` 同形状的 fetch；`AbortSignal` 透传成 HTTP abort。
  **不复用 Channel 编解码**——HTTP 下 `createProviderFetch` 直接消费原生 `Response`。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### M4 · server 版模型凭据宿主

- **依赖**：M1、S3
- **改动面**：新建 `apps/web/src/settings/serverModelCredentialHost.ts`；host-node 侧补
  `model_credential_status/set/delete` 三个命令
- **判据**：与 `createTauriModelCredentialHost()` 同接口；`status` 只回
  `{ configured, source }`，**任何路径都不回传 Key 本身**。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### M5 · 端到端验收：浏览器里跑完一轮对话

- **依赖**：M3、M4、B4
- **改动面**：无（验收卡）
- **判据**：**主会话亲自。** 浏览器里完成一轮真实对话（含至少一次工具调用），
  流式输出可见、可中断。记录留在 scratchpad
- **模型**：—（主会话亲自）
- **状态**：TODO

---

## C · MCP 与事件通道

### C1 · host-node 的 MCP stdio 传输

- **依赖**：N3
- **改动面**：`packages/host-node/src/mcp/`
- **判据**：对齐 `mcp_session*.rs` + `mcp_protocol.rs`：spawn、JSON-RPC 帧收发、
  超时、进程退出清理。**协议编排不重写**——`tools/mcp` 里已有 5178 行 TS 实现，
  本卡只做传输层。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### C2 · host-node 事件面

- **依赖**：N1
- **改动面**：`packages/host-node/src/events/`
- **判据**：新契约卡。`onHostEvent(name, handler): () => void`，覆盖
  `mcp-stdio-tools-changed` 与 `mcp-stdio-close`。CLI 进程内直接回调，无需序列化。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### C3 · server 的 SSE 事件端点

- **依赖**：C2、S2
- **改动面**：`apps/server/src/eventsRoute*`
- **判据**：`GET /api/events` 走 SSE；断线重连不丢事件语义要么保证、要么在卡上写明不保证
  并说明前端如何补偿。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### C4 · 前端 server 版 MCP connector 与配置存储

- **依赖**：C3、C1、B2
- **改动面**：新建 `apps/web/src/mcp/serverStdioConnector.ts`、`serverMcpConfigStorage.ts`
- **判据**：与 `tauriStdioConnector.ts` / `tauriMcpConfigStorage.ts` 同接口；
  `listen()` 换成 C3 的 SSE 订阅。跑 `pnpm exec vitest run apps/web/src/mcp`
- **模型**：opus
- **状态**：TODO

---

## P · 持久化收敛

### P1 · persistence-sqlite 抽 SQL 传输 port

- **依赖**：—
- **改动面**：`packages/persistence-sqlite/src/sqliteShared.ts` 及其消费方
- **判据**：跨包 API 卡。把直连 `@tauri-apps/plugin-sql` 换成可注入的 SQL 执行 port；
  Tauri 装配注入插件实现，行为不变。跑 `pnpm exec vitest run packages/persistence-sqlite` +
  `node scripts/check-boundaries.js`（`core 禁入 Tauri SQL 插件` 那条仍须绿）
- **模型**：opus
- **状态**：TODO

### P2 · host-node 的 SQLite 执行

- **依赖**：P1、N1
- **改动面**：`packages/host-node/src/sqlite/`
- **判据**：实现 P1 的 port；数据库路径与桌面版一致（`com.webagent.app/web-agent.db`），
  使两个宿主看到同一份会话。跑该目录 vitest
- **模型**：opus
- **状态**：TODO

### P3 · server SQL 端点与前端接线

- **依赖**：P2、S3、B3
- **改动面**：`apps/server/src/sqlRoute*`、`apps/web/src/persistence/persistenceDrivers.ts`
- **判据**：`persistenceDrivers` 从二选一变三选一；server 宿主下会话落 SQLite 而非 IndexedDB。
  跑 `pnpm exec vitest run apps/web/src/persistence apps/server`
- **模型**：opus
- **状态**：TODO

### P4 · observability-sqlite 同款收敛

- **依赖**：P3
- **改动面**：`packages/observability-sqlite/src/`、`apps/server/src/`
- **判据**：照 P1–P3 的范式；trace viewer 在 server 宿主下能读到 span。
  跑 `pnpm exec vitest run packages/observability-sqlite`
- **模型**：sonnet
- **状态**：TODO

---

## D · 分发

### D1 · 前端产物嵌入 server 包

- **依赖**：S1
- **改动面**：`apps/server/` 构建配置
- **判据**：`pnpm build` 后 server 包自带 `apps/web/dist`，单个 npm 包即可启动，
  不依赖仓库工作树。跑 `node scripts/check-dist.js`
- **模型**：sonnet
- **状态**：TODO

### D2 · npm 包元数据与 bin launcher

- **依赖**：D1、S4
- **改动面**：`apps/server/package.json`、`apps/server/bin/`
- **判据**：对外交付卡。`npm pack` 产物在**干净目录**里 `npx` 能起；
  `files` 字段不夹带源码与测试；Node 版本下限声明明确。
  跑 `npm pack --dry-run` 逐条核对文件清单
- **模型**：opus
- **状态**：TODO

### D3 · 发布流水线

- **依赖**：D2
- **改动面**：`.github/workflows/`
- **判据**：tag 触发、跑完整门禁（check-docs → check-boundaries → check-state → test → build）
  才发布；**不需要任何签名 Secret**。首次以 dry-run 模式验证
- **模型**：opus
- **状态**：TODO

### D4 · README 与 docs 更新

- **依赖**：M5
- **改动面**：`README.md`、`README.zh-CN.md`、`docs/README.md`、`CLAUDE.md`
- **判据**：对外长文写作卡。README 的「三个宿主」表述改为浏览器自托管 / CLI / 桌面套壳；
  删掉「浏览器预览下 Tauri 桥支持的工具不可用」这类已过期的说明；
  `CLAUDE.md` 的「持久化与运行环境」节同步。跑 `node scripts/check-docs.js`
- **模型**：opus
- **状态**：TODO

---

## T · Tauri 退成套壳

### T1 · Tauri 启动 sidecar Node 进程

- **依赖**：M5
- **改动面**：`apps/desktop/src/lib.rs`、`apps/desktop/tauri.conf.json`
- **判据**：Tauri 启动时拉起 server 进程并等它 ready，退出时确保子进程被回收
  （**不留孤儿进程**）。端口与 token 经内部通道传给前端。
  跑 `cargo test --manifest-path apps/desktop/Cargo.toml`
- **模型**：opus
- **状态**：TODO

### T2 · 桌面前端切到 server 宿主

- **依赖**：T1、B3
- **改动面**：`apps/web/src/host/resolveHost.ts` 及装配层
- **判据**：Tauri 内也走 server 宿主的 invoke；`workspaceDialog` 仍走原生插件（见未决）。
  跑 `pnpm exec vitest run apps/web` + `pnpm tauri dev` 手动确认
- **模型**：opus
- **状态**：TODO

### T3 · 删除 Rust 业务代码，只留窗口壳

- **依赖**：T2、W17
- **改动面**：`apps/desktop/src/` 的 workspace / shell / mcp / model / config 全部模块
- **判据**：**大删除卡，必须在 W16/W17 对拍全绿之后**。删完
  `wc -l apps/desktop/src/*.rs` 应在数百行量级；`pnpm tauri build --no-bundle` 通过
- **模型**：opus
- **状态**：TODO

### T4 · CI 精简

- **依赖**：T3
- **改动面**：`.github/workflows/ci.yml`
- **判据**：三平台 `cargo test` 缩到窗口壳规模；总时长下降。跑 CI 一轮
- **模型**：sonnet
- **状态**：TODO

---

## 未决

**U-1 · `workspaceDialog` 的浏览器替代。**
`packages/agent-core/src/runtime/workspaceDialog.ts` 用 `@tauri-apps/plugin-dialog` 开原生
目录选择框，浏览器里无等价物（File System Access API 拿不到真实路径）。三个选法：
server 端做目录浏览 UI（体验最好，约 3 卡）／输入框手输路径 + server 侧校验（约 1 卡）／
读配置文件里的 workspace 列表（约 1 卡）。T2 之前桌面侧仍可用原生插件，所以不阻塞主线，
但纯浏览器版在此之前无法切换工作区。

**U-2 · 对拍 fixture 的覆盖下限。**
W16/W17 覆盖 patch、change journal、写锁、读限额。是否要求 Rust 侧 161 个测试函数全部
有 TS 对应，还是只钉住上述四块的边界用例？前者成本高一个量级，后者留下未覆盖面。
T3 的删除动作依赖这条的答案。

**U-3 · 多 workspace 切换。**
桌面版靠原生目录选择器切工作区。浏览器自托管下，是让 server 启动时用 `--workspace` 固定一个，
还是支持运行时切换？影响 S4 与 U-1 的选型。
