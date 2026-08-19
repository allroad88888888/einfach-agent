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
H  core host bridge 抽象        H1 → H1b → H2/H3/H4/H4b → H4c/H4d-1→H4d-2/H4e → H5 → H6
N  host-node 薄包装区           N1 → N2 → N3/N4/N5/N6/N7 → N8 ★CLI 完整
W  host-node 真逻辑区           W1..W15 → W16/W17 对拍
S  server HTTP 外壳             S1 → S2/S3/S5 → S4
B  前端 server 宿主装配          B1 → B2 → B3 → B4 ★浏览器 fs/shell 可用
M  模型代理                     M1 → M2/M4 → M3 → M5 ★浏览器完整对话
C  MCP 与事件通道               C1/C2 → C3 → C4
P  持久化收敛                   P1 → P2 → P3 → P4
D  分发                        D1 → D2 → D3 → D4
T  Tauri 退成套壳               T1 → T2 → T3 → T4
未决                           目录选择器 / 对拍覆盖下限 / 多 workspace 切换
```

**MVP 路径 = H + N + W1–W15 + S + B + M**（约 46 卡）。到 M5 浏览器版即可用；
C/P/D/T 是增强与收尾，可后置。

全树 67 卡（H 线在执行中由 6 张增至 12 张，S 线因 N3 交回的 platform 阻断项增至 5 张，五张都是验收时才浮出来的：H1b 三卡共享测试脚手架、
H4b 从 H4 里拆出的总闸、H4c 验收漏扫 apps 面留下的回归、H4d 拆树后新增文件带来的缺口、
H4e 总闸改名的下游收尾）。

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
`scripts/check-boundaries.js` 的 `capabilityPackages` 数组。（N1 落地时实际改了**四**处：
同文件 `coreRules` 的「core 禁入能力包」清单也加了 `@web-agent/host-node`——core 反过来引它
就等于把「宿主是什么」重新焊回 core，正是 H 线拆掉的那件事。）

### 移植中发现的 Rust 侧问题（汇总，W16/W17 对拍前必读）

等价移植的纪律是**照搬 + 记录，不在移植卡里单方面改** ——错误文案与行为是两个宿主的对外契约，
改一个字就是制造分叉。但照搬不等于认可，下面这些是移植时实际发现的、Rust 侧本身就不对或值得
两边一起改的地方。**对拍撞上时该改哪一边，逐条已有判断。**

已在 Node 侧修掉（可观测输出仍逐字相同）：

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | `workspace_common.rs:143` | 每个读取块单独 `from_utf8_lossy`，多字节字符被块边界劈开时两半各变成 `�`；中文输出跨块就坏字。Node 用 `StringDecoder` 跨块保留不完整序列。**对拍撞上时改 Rust。** |
| 2 | `workspace_change_journal.rs` 的 `write_entry` | `fs::write` + `rename`，**没有 fsync**。而这份文件是「这次改动可撤销」的唯一凭据，掉电后目录项指向空洞内容 = 那次改动永久撤不回来且不报错。Node 走 `atomicWrite`（含 fsync）。 |

照搬未改，但已标记：

| # | 位置 | 问题 |
| --- | --- | --- |
| 3 | `workspace_change_journal_types.rs` 的 `FileSnapshot` | `content: Option<String>`，而 serde 对 `Option<T>` 的缺失字段有特判（直接 `visit_none()`）——一份**被截断的条目不会解析失败**，而是被当成 `content: null`，回滚时那等于「文件原本不存在」，于是**删掉用户的文件**。收严会拒掉桌面端写的合法条目，要修该两边一起加 `exists === (content !== null)` 的自洽校验。 |
| 4 | `workspace_write_before.rs:44` | 文案 `existing file exceeds reversible {MAX_BYTES} byte limit` 里的 "reversible" 与它实际用的常量对不上（`MAX_BYTES` 是 8 MiB 硬顶，`REVERSIBLE_MAX_BYTES` 才是 1 MiB）。 |
| 5 | `workspace_read*` 与 `workspace_delete.rs` 的错误消息 | 用**绝对路径**（`display_path`），而返回值里的 `path` 是根相对——一次失败会把宿主机绝对路径写进模型可见的错误文本。W10 交回时点名：删除侧的软链拒绝文案同样如此（`` `/Users/…/workspace/linked` ``），且比读取侧更值得列，因为它出现在一次被拒绝的破坏性操作里。 |
| 6 | `workspace_git.rs` 的 `parse_changed_files` | 不解 git 的 C-style quoted path，`core.quotePath` 开着时非 ASCII 文件名会是 `"\303\251.txt"`。 |
| 7 | `workspace_git_exec.rs` | `status --short` / `--stat` / `--name-only` **不设输出上限**（只有 diff 正文有 cap）。巨型仓库的 `status --short` 会整份进内存和返回值。 |
| 8 | `runtime/shellCommand.ts` 的 `normalizeResult` | 超时命令的 `exit_code: null` 被整形成 `-1` 并追加 `run_shell_command returned a response without a valid exit code`——对模型来说「超时被杀」被说成「桥返回了非法响应」。改动要 core + Rust 一起动。 |
| 9 | `workspace_rg.rs` | 不传 `path` 时 target 是 `.`，rg 于是给每个结果路径加 `./` 前缀，而 `normalize_display_path` 只剥绝对路径。 |

顺带发现的 TS 侧 bug（不在本树范围，未改）：

| # | 位置 | 问题 |
| --- | --- | --- |
| 10 | `vite.config.ts:58` 的 `defaultTraceDbPath()` | Linux 分支写的是 `process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share')`，而 `dirs` crate 的判据是 `env::var_os("XDG_DATA_HOME").and_then(dirs_sys::is_absolute_path)`——**必须是绝对路径才采用**。且 `??` 只挡 `null`/`undefined`，**空串会被当有值**，`path.join('', …)` 变成跟着进程 cwd 走的相对路径。 |

| 11 | `workspace_patch_path.rs:101` 与 `workspace_path_ops.rs:224` | 这两处的展示路径**无条件** `.replace('\\', "/")`，而 `workspace_write_target_path.rs` / `workspace_read_paths.rs` 的 `path_to_slash_string` 是 `if MAIN_SEPARATOR == '/' { 原样 }`——**同一仓库里两种做法**。unix 上 `\` 是合法文件名字符，于是真名 `a\b.txt` 的文件在读/写侧原样保留、在 patch 与 path_ops 侧变成 `a/b.txt`；而 patch 那个结果会**写进变更日志**，回滚时按另一个路径去找。W12 发现，主会话已复核四处实现。 |

| 12 | `workspace_write_result.rs` 的 `WorkspaceWriteResult` | 它是 `#[derive(Serialize)]` **没有 `rename_all`**，所以写入回执的顶层键是 snake_case（`bytes_written` / `change_set` / `dry_run`…），而 `workspace_read_types.rs` 与 `workspace_patch_result.rs` 都带 `rename_all = "camelCase"`——**同一仓库两种线上形状**。core 的 `normalizeResult` 两种都收，所以今天两边都跑得动，但 W16/W17 对拍会撞上。W7 发现，主会话已复核三个结构的 serde 属性。Node 侧照搬了 snake_case。 |

| 13 | `workspace_delete.rs` 的 `path does not exist` | 这句话**在正常路径上永远不会出现**：`resolve_delete_path` 对**最后一段**也做 `symlink_metadata`，所以目标不存在时先失败成 `failed to resolve target path: No such file or directory (os error 2)`；caller 里那个 `ErrorKind::NotFound → "path does not exist"` 分支只在 TOCTOU 窗口里可达（同理 caller 的 `is_symlink()` 判断也不可达）。W10 照搬了（TOCTOU 下仍有意义）并把测试钉成「报的是解析失败」。**W16/W17 对拍时别指望能构造出这句话。** |

**⚠️ 跨宿主隐患（T 线套壳前必须解决）**：`workspaceRoot` 在变更日志里存的是 canonicalize 后的
绝对路径、回滚时逐字比对。Rust 的 `fs::canonicalize` 在 Windows 上给 verbatim 前缀
（`\\?\C:\…`），Node 的 `realpath` 给 `C:\…`——**套壳后同一个 workspace 会被判成
`workspace_mismatch`，回滚全部失败**。POSIX 上两者一致，所以 W14/W15 都没动。

### host-node 施工须知（N1 交回，N/W/S 全线共同依据）

**落地一域 = 建目录 + 写 registrar + 在 `createRoutes` 加一行展开。** 样板是
`packages/host-node/src/config/`：handler 是工厂形态（收 options 返回 handler），`index.ts` 是域
registrar（`create<Domain>Routes(options) => NodeHostRouteTable`）。**不要在 `createNodeHostInvoke.ts`
里直接写 handler**，28 条摊进去必顶破 300 行。

**没实现的命令不要写恒抛错的占位 handler。** 路由表是 `Partial`，缺席就是「键不存在」；写占位会让
分发层把它认成「已实现但坏了」。分发层区分两种失败：`unimplemented`（在命令全集里但本次装配没有
实现）与 `unknown-command`（不在全集内），S 线可按 `reason` 字段映射 501 / 404——**用字段而不是
`instanceof`**，错误要跨 HTTP 序列化。失败一律是 rejection 不是同步抛出。

**入参大小写不是「全都 snake_case」，是两层各有各的规则**（N1 逐条核对过 28 条）：
① 14 条带 `rename_all = "snake_case"`（全部 workspace/* 与 shell），顶层键是 snake_case，
core 的 `toTauriInput` / `toTauriReadInput` 已经转好，**路由表拿到的就是 snake_case，不要再转**；
② 另 14 条没有该属性，走 Tauri 默认转换，其中参数多为单词或无参、大小写无差别，**唯二例外**是
`cancel_model_provider_request` / `cancel_model_chat_completions` 的 `requestId`（camelCase）；
③ **嵌套载荷一律 camelCase，与命令的 rename_all 无关**——最坑的是 `write_workspace_file`：
顶层键 `change_context` 是 snake_case，值里却是 `changeId` / `sessionId` / `runId` / `toolCallId`
（`workspaceWrite.ts:102` 实证）；`apply_workspace_patch` 的 `operations[]` 更混，判别键 `type`
取值是 snake_case（`add_file` / `overwrite_file`），字段却是 camelCase（`oldText` / `newText`）。

**handler 收到的是 `Record<string, unknown>`，必须自己收窄。** `commandArgs.ts` 是收窄的**目标形状**，
不是替代品——同一张表要挂在 HTTP 后面，那条路上载荷是外部输入。

**判参数存在只能看值，不能用 `'key' in args`。** core 的 `toTauriInput` 整份对象字面量返回，
可选项无值时**键存在且为 undefined**；进程内注入（CLI / sidecar）原样到达，走 HTTP 时
`JSON.stringify` 会把它丢掉。同一份入参在两种传输下键集合不同，用 `in` 会写出
「本地能跑、上 server 就变」的 bug。

**两条反向通道不在 `(cmd, args) => Promise<T>` 的形状里**：`model_provider_request` /
`model_chat_completions` 有第三个参数 `events: Channel<ModelProxyEvent>`（不是 JSON），
`mcp_connect` 之后还有一路 Rust `emit` / 前端 `listen` 的 stdio 生命周期事件。它们归 `events/` 域
（C2 卡），是独立设计而非某条命令的实现细节——**M 线与 C 线的命令实现要等 C2**。

**`sqlite/` 域当前零命令**：桌面侧走 `@tauri-apps/plugin-sql`，不在本仓库的 `#[tauri::command]`
列表里。P2 定下命令名后**必须回来登记进 `NODE_HOST_COMMANDS_BY_DOMAIN`**，否则分发层会以
`unknown-command` 拒绝它。

**`commandNames.test.ts` 逐字比对 `apps/desktop/src/lib.rs` 的 `generate_handler!` 登记列表**——
Rust 侧增删命令而这里没跟上，该测试当场红（主会话已用「删掉一条命令」的探针验证它真会红，
不是空跑）。另有一条 `implemented` 断言列出当前已实现的命令名，落地一个域就把命令名加进那个
数组，**别把断言改成宽松匹配**。

**跑单包 build 前先确保 core 已按拓扑序构建**：能力包的 `tsconfig.build.json` 指向 core 的 **dist**，
而 core 的 dist 可能是陈旧的（N1 就撞上一份不含 H 线 `HostInvoke` 导出的旧产物，声明 emit 阶段
报 TS2305）。这一条不在 CI 里，容易踩。

**`model_chat_completions` / `cancel_model_chat_completions` 全仓零 TS 调用方**（Rust 侧给旧渲染层
留的兼容命令），登记在册是因为 `lib.rs` 里确实有，实现优先级最低。

---

## H · core host bridge 抽象

### H1 · 把 invoke 抽成可注入的 host bridge 契约

- **依赖**：—
- **改动面**：新建 `packages/agent-core/src/runtime/hostBridge.ts` 与 `hostBridge.test.ts`；
  `packages/agent-core/src/index.ts` 导出（装配层调不到的 `configureHostInvoke` 等于没交付，
  可达性属于本卡契约的一部分）
- **判据**：导出 `HostInvoke` 类型、`configureHostInvoke(loader)`、`hasHostBridge()`、
  `loadHostInvoke()`。**注入的是 loader（`() => Promise<HostInvoke>`）不是已解析的 invoke**——
  装配层拿 invoke 本身是异步的，注入已解析值会让「工具在注入完成前执行」变成一个时序竞态。
  `hasHostBridge()` 判的是 loader 是否已登记，同步可答。loader 只解析一次并缓存
  （照抄 `hostTauri.ts` 的 `??=` 理由：并发首次调用时 Vitest mocker 有一路会拿到未替换的真模块）。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/hostBridge.test.ts`
- **模型**：opus
- **状态**：DONE `5136364`。两处实现决策记在源码注释里：① loader 失败**不进缓存**（清回
  `undefined` 让下次重试，清理前比对 promise 身份，避免旧 loader 慢一步失败时清掉新桥的缓存）
  ——这与 `hostTauri.ts` 无条件缓存 rejection 的行为有意不同，那边是存量，本卡不顺手改；
  ② 未登记时以 **rejection** 失败而非同步 throw，因为本函数对外承诺返回 Promise，
  同步抛出会绕过 `.catch` 链变成未捕获错误。barrel 只收 `configureHostInvoke` + `HostInvoke`
  类型，`hasHostBridge` / `loadHostInvoke` 的消费方全在 core 内部。

### H1b · 共享测试脚手架加 hostBridge 版 mock 工厂

- **依赖**：H1
- **改动面**：`packages/agent-core/src/runtime/hostTauri.testHarness.ts`
- **判据**：**本卡因验收 H1 时发现三卡共享改动面而新增。** `hostTauri.testHarness.ts` 导出的
  `hostTauriBridgeMock` 被 `workspaceRead.contentHash` / `workspaceRead.runIndexPage`（H2）、
  `workspaceWrite`（H3）、`shellCommand.backgroundKill`（H4）四个桥测试共用——H2/H3/H4 若各自
  去加 hostBridge 版工厂，三个 agent 会同时改这一个文件。本卡先行把冲突面摘出来。
  加 `hostBridgeMock(loadHostInvoke)` 供 `vi.mock('./hostBridge')` 用，形状对齐现有
  `hostTauriBridgeMock`（`hasHostBridge` 恒真 + 调用方给的 loader），沿用文件里那段关于
  vi.mock hoisting 限制的说明。**旧工厂保留不动**：H2/H3/H4 逐卡切换，全切完才零消费方，
  由 H6 一并删。跑 `pnpm exec vitest run packages/agent-core/src/runtime`
- **模型**：sonnet
- **状态**：DONE `66b9872`。纯新增 39 行、零删除，旧工厂原样。新工厂的返回类型用 hostBridge 的
  `HostInvoke` 而非借桌面包的 invoke 类型；注释里为解释「特意没用那个类型」提及了包名，
  经核实 `.testHarness.ts` 不进发布物、`packages/agent-core/dist` 的 `.d.ts` 里该字符串仍零命中，
  D9 纪律未破。

### H2 · workspace 读侧四模块改走 host bridge

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `workspaceRead.ts`（5 处）、`workspaceRg.ts`、
  `workspaceGit.ts`、`workspaceTask.ts`
- **判据**：`isTauriHost()` → `hasHostBridge()`、`loadTauriInvoke()` → `loadHostInvoke()`，
  invoke 的 command 名与参数**逐字不变**。四个文件内 `hostTauri` 的 import 归零。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/workspaceRead` 与同目录 Rg/Git/Task 用例
- **模型**：sonnet
- **状态**：DONE `fc69162`。18 增 18 删的纯 identifier 替换，command 名与错误文案零命中 diff。
  Rg/Git/Task 三个模块没有 colocated 测试，读侧只有 workspaceRead 那两个桥测试切了工厂。
  **顺带记一个存量问题**：`workspaceRead.ts` 404 行，超 300 上限。本卡是等量替换未改变行数，
  按「路过存量超限文件小改只指出不重构」的规矩没动它。它主要是类型定义 + 参数转换的薄转发层，
  真正的拆分时机在 W1–W4 落地后（那时这个文件的定位会变），不单开卡。

### H3 · workspace 写侧五模块改走 host bridge

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `workspaceWrite.ts`、`workspacePatch.ts`、
  `workspaceDelete.ts`、`workspacePathOperation.ts`、`workspaceChange.ts`
- **判据**：同 H2；额外确认 `workspacePatch.ts` / `workspaceWrite.ts` 传给 observability 的参数未动。
  跑 `pnpm exec vitest run packages/agent-core/src/runtime/workspaceWrite.test.ts` 与
  `workspacePatch.timing.test.ts`
- **模型**：sonnet
- **状态**：DONE `c4c8ded`。17 增 17 删纯 identifier 替换，observability 参数链与
  `dispatchStartedAt` / `invokeDispatchMs` 计时未进 diff。跟随改了一处类型标注
  `Awaited<ReturnType<typeof loadTauriInvoke>>` → `…loadHostInvoke>>`。
  `workspacePathOperation.ts` 的守卫与文案写在同一行，整行必然进 diff 但文案两侧逐字相同。
  Delete / PathOperation / Change 三个模块全仓无 colocated 测试（已 grep 函数名确认）。

### H4 · shell 与 projectSkillsBridge 改走 host bridge

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `shellCommand.ts`、`projectSkillsBridge.ts`
  及其 colocated 测试
- **判据**：同 H2。两处**范围收窄**（原卡面写的是三个模块）：`modelTurnPrefix.ts` 拆去 H4b，
  因为它那处 `isTauriHost()` 不是早退守卫而是工具可见性总闸，改动性质完全不同；
  `workspaceDialog.ts` 始终不在范围（它用的是 `@tauri-apps/plugin-dialog` 而非 core invoke，
  归未决项 U-1）。跑 `pnpm exec vitest run packages/agent-core/src/runtime/shellCommand`
- **模型**：sonnet
- **状态**：DONE `f6e3b9b`。5 增 5 删。`projectSkillsBridge.ts` 的用法与 shellCommand 不同：
  它**只用守卫、不取 invoke**——实际 IO 委托给 `listWorkspaceFiles` / `readWorkspaceFile`
  （H2 改动面），所以那边只换了 `hasHostBridge()` 一处。

### H4b · 工具可见性总闸从「是不是 Tauri」改成「有没有桥」

- **依赖**：H1b
- **改动面**：`packages/agent-core/src/runtime/` 的 `modelTurnPrefix.ts`、`turnToolVisibility.ts`、
  `toolManifest.ts`、`turnToolSet.ts`，以及 `modelRun.requestProjection.test.ts`、
  `modelRun.dangerousToolConfirmation.test.ts`
- **判据**：**本卡因验收 H1 时发现 H4 卡面定性错误而拆出，是整棵树的总闸。**
  `turnToolVisibility.ts:31` 的 `isToolVisible(runtime, isTauri) => runtime !== 'server' || isTauri`
  决定**模型能不能看到文件与 shell 工具**——`runtime: 'server'` 不是某个叫 server 的工具，
  而是「需要本机能力」这一整类。这个 flag 从 `modelTurnPrefix.ts:45` 的 `isTauriHost()` 出发，
  经 `buildToolManifestText` / `buildTurnTools` 流到 `availableToolSummaries` 与 `isToolVisible`，
  沿途参数名一律叫 `isTauri`。**后端做得再全，这个 flag 不翻，Web 版就是空的。**
  本卡把源头换成 `hasHostBridge()` 并把沿途参数改名（`isTauri` → 表达「有本机能力」的名字），
  两个 modelRun 测试里的 `stubTauriHostFlag(true)` 相应换成登记一个假 loader——
  `hasHostBridge()` 看的是 loader 是否登记，不再看 `globalThis.isTauri`，不换则测试失去意义。
  **连带影响要在卡上写明结论**：`tools/mcp/src/placeholderTool.ts` 的注释说明 MCP stdio 占位
  工具正是靠这个过滤在浏览器下隐藏，闸门翻开后 C 线完成前它会可见但不可用——是接受这个窗口期
  还是加一层更细的能力粒度，本卡给出判断并记录。
  跑改动面相关测试；**全量与 `pnpm build` 由主会话验收时统一跑**——本卡与 H2/H3/H4 并行，
  工作树上有它们的中间态，全量失败会归因不清，且并发 build 会争 `dist/`。
- **模型**：opus
- **状态**：DONE `1f12abb`。参数名定为 `hostHasLocalCapabilities`：带 `host` 前缀避免在
  `isToolVisible(runtime, X)` 里被误读成「这个工具有本机能力」；用「能力」而非「桥」是因为
  桥只是当前实现手段，把手段写进语义参数名等于把刚拆开的耦合换个名字焊回去。
  **单源已独立复核**：`modelTurnPrefix.ts:64` 是唯一源头，三条流（清单文本、tools 数组、
  `toolCallGate` 的执行期拒绝）加子 Agent 那份全部由它喂。子 agent 另做了反向对照——
  把桩改成 false 后 15 例倒 7 例，且倒的正是依赖 server 工具可见性的那些，证明桩承重不是摆设。
  **共享脚手架被迫分家**（卡面没预见）：`stubHostBridgeFlag` 必须对 `./hostBridge` 做值导入，
  而 `hostTauri.testHarness.ts` 被四个 `vi.mock('./hostBridge')` 的桥测试 import，
  vi.mock 提升到 import 之前 → 值导入撞进被 mock 模块的 TDZ（实测 4 个文件报
  `Cannot access '__vi_import_0__' before initialization`）。故新开 `hostBridge.testHarness.ts`，
  原脚手架对 hostBridge 只留 `import type`。两边都留了注释记这个坑。
  超出卡面改了 3 行（`toolLoopBootstrap.ts` ×2、`transcriptInjection.test.ts` ×1），是字段改名的
  必然连带。

### H4c · 修 apps/web 插件测试的宿主桩（H2/H4 回归）

- **依赖**：H4b
- **改动面**：`apps/web/src/plugins/initialize.test.ts`
- **判据**：**来源：H2/H4 的回归，主会话验收时漏扫 apps 面，由 H4b 的子 agent 在裸 HEAD
  `c4c8ded` 复跑时发现。** `projectSkillsBridge.ts` 的判据换成 `hasHostBridge()` 之后，
  该测试仍用 `stubTauriHostFlag` 切 `globalThis.isTauri`，两个用例失败。改用 H4b 新增的
  `stubHostBridgeFlag`（`packages/agent-core/src/runtime/hostBridge.testHarness.ts`）。
  跑 `pnpm exec vitest run apps/web` 全绿
- **模型**：sonnet
- **状态**：DONE `f0967e0`。apps/web 全量 98 文件 / 673 例全绿。**卡面给的修法是错的，实测推翻了**：
  `stubHostBridgeFlag` 的 loader 故意解析出一个恒 reject 的 invoke，而本文件两条 Tauri 用例的断言
  需要 `list_workspace_files` 真的带着正确参数打到 invoke mock 上——换上去后 hydration 停在
  `status:'error'`、`listedRoots()` 恒空。最终改为直接 `configureHostInvoke` 登记一个转发到
  文件既有 `invokeMock` 的 loader（即 H5 桌面装配在测试里的等价物）。
  **另踩一个模块身份陷阱**（对 H4d-2 之后的所有测试卡都成立）：`configureHostInvoke` 改的是
  `hostBridge.ts` 的模块级变量，而该文件的 `freshHost` 每次先 `vi.resetModules()`；顶层静态 import
  拿到的是收集阶段那份**旧**模块实例，被测代码动态 import 拿到的是重置后的新实例，于是登记不生效、
  现象与上面那条一模一样。解法同文件里已有的 `uiStore` 动态重导入模式：在 `resetModules()` 之后
  再动态 import，用模块级可变引用接住供顶层 `afterEach` 复位。

### H4d · userSkillsRoot 改走 host bridge（已拆为 H4d-1 / H4d-2）

**改写原因**：调研交回的结论是这张卡不能只改一个文件。`resolveUserSkillsRoot` 走的不是 invoke，
而是 `hostTauri.ts:70` 那条 **core 的第二条 `@tauri-apps` 运行时边**（`import('@tauri-apps/api/path')`
取 `homeDir()`），而 Rust 侧 27 个 command 里**没有**主目录命令。于是纯替换两种写法都错：
保留 path 模块的话，登记了桥但没装 `@tauri-apps/api` 的 Node/浏览器宿主动态 import 失败 → 静默
返回 undefined，等于没改；直接换成 invoke 的话，Rust 没这个命令，H5 一落地**桌面端的 user skills
会静默消失**。三条事实已由主会话独立复核（`loadTauriHomeDir` 全仓单消费方、Rust 无该 command、
返回值确实被当 confinement 根用）。

**选型：新增桥命令 `get_user_home_dir`，不做 core 注入槽。** 决定性理由是这个值的用途——
它随后被 `tools/skills/src/projectSkillsLoader.ts` 当作**桥调用的 confinement 根**传回去
（`workspaceRoot: root.root` + `allowExternalPaths: true`）。它只在「桥背后那台机器的文件系统
命名空间」里有意义：浏览器接 Node 后端时，主目录是**服务端**那台机器的，前端无从知道。
让它和文件读取走同一个权威，「根是桥所在机器上的真实路径」才是结构性成立的。
注入槽还有两个毛病：server 宿主下浏览器无论如何都得经 `/api/invoke/:command` 拿服务端主目录，
命令消不掉，再加一个槽等于一件事两套机制；且槽的失败形态正是本仓库最忌讳的那种——某个宿主忘了
注入则 user skills 静默缺席、不报错，而桥只有 `configureHostInvoke` 一个登记点，漏不掉。

已否决的省事方案：在 H5 的 Tauri 装配层包一层 shim，把 `get_user_home_dir` 就地映射到
`@tauri-apps/api/path`（省掉写 Rust）。它在 invoke 路由里塞一个按命令名的分支，路由表就不再是
「有哪些命令」的唯一权威，且 T2 必须记得拆。宁可写 15 行 Rust，T3 跟着其余业务代码一起删。

### H4d-1 · Rust 新增 `get_user_home_dir` 命令

- **依赖**：—
- **改动面**：新建 `apps/desktop/src/user_paths.rs`；`apps/desktop/src/lib.rs` 加一行 `mod` 与
  一行 `generate_handler!` 条目
- **判据**：`#[tauri::command] pub fn get_user_home_dir(app: AppHandle) -> Result<String, String>`，
  走 `app.path().home_dir()`，失败文案照抄 `web_agent_config_store.rs:64` 的「无法定位用户主目录」，
  非 UTF-8 路径单独报错。**返回原始字符串、不做尾斜杠归一**——归一留在 core 一份，三个宿主共用。
  诚实记录：这是 AppHandle 的薄包装，与 `WebAgentConfigStore::from_app` 同形，**没有有意义的单测**
  （既有测试都从 `from_home_directory` 绕开 AppHandle）。验收 =
  `cargo test --manifest-path apps/desktop/Cargo.toml` 仍绿 + `pnpm tauri build --no-bundle` 编译通过
- **模型**：sonnet
- **状态**：DONE `925083c`。15 行，`lib.rs` 加两行。非 UTF-8 用
  `into_os_string().into_string()` 而非 `to_string_lossy()`——后者会把不可转字符静默换成
  U+FFFD，产出一个看似正常实则打不开的路径，故障现场离病因十万八千里。
  没加 `rename_all`（除注入的 `AppHandle` 外无参数，跟随 `mcp_config_read` 的先例）。
  161 个既有 Rust 测试仍绿；`generate_handler!` 是编译期宏，编译通过即验证了注册。

### H4d-2 · userSkillsRoot 改走桥，并删掉 core 的第二条 Tauri 运行时边

- **依赖**：H4d-1（**反序会在 H5 落地时让桌面端 user skills 静默消失**）
- **改动面**：`packages/agent-core/src/runtime/userSkillsRoot.ts` 及其测试；`hostTauri.ts`（删死代码）
- **判据**：守卫换 `hasHostBridge()`，取值改 `await invoke<string>('get_user_home_dir')`，
  **显式判 `typeof` 是字符串再 trim**（`invoke<T>` 不做校验）。`stripTrailingSlash` 与
  「失败一律降级 undefined」两段语义和注释逐字保留，只把「homeDir 在不同 Tauri 版本上带不带尾斜杠
  不一致」改成按宿主实现措辞。`hostTauri` import 归零后，`hostTauri.ts:63-74`
  （`TauriHomeDirFn` / `tauriPathModule` / `loadTauriPath` / `loadTauriHomeDir`）零消费方 →
  **一并删除**，core 的 `@tauri-apps` 运行时边从两条降到一条。
  **测试改法写死在卡上**：不要用 `hostBridgeMock`（它把 `hasHostBridge` 钉死为 true，而本文件的
  守卫正是被测对象），也不要用 `stubHostBridgeFlag`（它的桩 invoke 恒 reject，喂不出返回值用例）。
  直接用真实 hostBridge 模块 + `configureHostInvoke(() => Promise.resolve(invokeStub))` /
  `configureHostInvoke(undefined)` 切换，`afterEach` 复位，零 mock、无 TDZ 风险。
  现有 5 个用例 1:1 平移。跑 `pnpm exec vitest run packages/agent-core/src/runtime/userSkillsRoot.test.ts`
  + `pnpm exec vitest run tools/skills packages/agent-core/src/skills`
- **模型**：sonnet
- **状态**：DONE `3d9a6ce`。死代码已删净（全仓 grep 零残留），**core 的 `@tauri-apps` 运行时边
  从两条降到一条**——`hostTauri.ts` 只剩第 57 行那个 `import('@tauri-apps/api/core')`；
  core 生产代码里另一条是 `workspaceDialog.ts:52` 的 plugin-dialog（未决项 U-1）。
  **主会话验收时改了一处交回的测试**：「无桥」用例原写成「造一个会计数的 loader、特意不登记它、
  断言 calls 为 0」，那是永真断言——loader 压根没登记，计数当然是 0，连守卫被整个删掉都发现不了
  （守卫失效时会走到 `loadHostInvoke()` 拿 rejection 再被 catch 降级，计数同样是 0）。
  不 mock hostBridge 就无法区分这两条路径，已改成只断言外部契约并把这个理由写进注释。

### H4e · 收掉 `runtimeIsTauri` 这个旧名字

- **依赖**：H4b
- **改动面**：`ToolLoopBase.runtimeIsTauri`、`SubagentRuntimeOpts.runtimeIsTauri` 及其全部消费方
  （`toolLoopBootstrap` / `modelTurnRequester` / `toolCallGate` / `childAgentLoop` /
  `childAgentToolCalls` / `childToolVisibility` / `childResult` 等，15+ 文件及测试）
- **判据**：**来源：H4b 的建议。** H4b 只改到卡面四个文件之内，接缝停在
  `runtimeIsTauri: stablePrefix.hostHasLocalCapabilities`——旧名字被喂新语义这件事在源码里
  看得见（两处都写了注释），不是静默的，所以不阻塞任何卡。本卡把名字收干净。
  纯改名，跑 `pnpm exec vitest run packages/agent-core` 全量
- **状态**：DONE `5f40682`。21 个文件、45 处命中，44 增 51 删——多删的 7 行正是两段「待办」注释。
  diff 里除 identifier 外只有一行改动：`subagents/runtimeState.ts` 的字段注释原文写着
  「runs inside the native Tauri host」，与新名字和新语义直接冲突，跟着改了。
- **模型**：sonnet

### H5 · Tauri 装配层注入 invoke loader

- **依赖**：H2、H3、H4、H4b
- **改动面**：`apps/web/src/main.tsx`（tauri 分支）、`apps/web/src/test/setup.ts`（测试宿主注入）
- **判据**：桌面宿主下 `configureHostInvoke(() => loadTauriInvoke())` 在
  `registerStandardTools` 之后、任何工具可能执行之前完成。**这卡是 H 线的试金石**：
  跑 `pnpm exec vitest run packages/agent-core apps/web` 全绿 + `pnpm build`，
  桌面版行为与 H1 之前逐项一致
- **模型**：opus
- **状态**：DONE `2fde7cc`。登记点落在 `registerStandardTools` 之后的第一个装配块：模块体到末尾
  `void bootstrapApplication()` 之前全程同步，因此先于**所有**异步续段。除了「恢复出来的会话可能
  带着未完成 run」这个显而易见的时点，还有一个静默失败点值得记：`initializePluginSettings()` 那条
  workspace root 订阅触发的插件扫描里，`desktopProvider.resolveBridge()` 会求值一次
  `buildProjectSkillsWorkspaceBridge()` 并 `??=` **缓存**结果——那一刻没有桥的话，缓存下来的
  `undefined` 会让插件面在整个进程生命周期里都报「当前宿主没有 workspace 文件系统通路」，且不自愈。
  **不走 core 的 `loadTauriInvoke()`**：它不在 `@web-agent/core` 公开面上，深导入
  `@web-agent/core/runtime/hostTauri` 会撞 `check-boundaries` 的公开面白名单（S9，硬 error 不是
  观察项）；要不要放上公开面是 core 自己的决策。装配层自持 loader 反而更贴 H 线的方向。
  `setup.ts` 未动，而且是**实验验证**过的决定：临时加一个全局桩桥后重跑，恰好只有本卡新增的两个
  用例失败、其余零影响——全局桩既没必要，又会把本卡要证明的性质本身证伪。
  **纠正一个数字**：`runtime: 'server'` 的生产工具是 **16 个**（`tools/fs` 10 + `tools/shell` 6），
  不是先前记的 17——第 17 个 grep 命中是 `toolCallBatch.authorization.testFixtures.ts` 里的测试夹具。
  已独立复核。
  **未验证项（如实记录）**：没有真的启动桌面 app（`pnpm tauri dev`）。「桌面版行为与 H1 之前逐项
  一致」建立在测试与代码推理上，不是跑过桌面二进制。

### H6 · 宿主不可用文案去 Tauri 化

- **依赖**：H2、H3、H4、H4b、H4c、H4d-2
- **改动面**：11 个 runtime 模块里的 fail 文案（`shellCommand` / `workspaceChange` / `workspaceDelete` /
  `workspacePatch` / `workspaceRg` / `workspaceTask` / `workspaceDialog` / `workspaceGit` /
  `workspacePathOperation` / `workspaceRead` ×4 / `workspaceWrite`，共 15 处）；
  **`toolContext.subagentArchive.test.ts`（3 处断言了这句文案）**；`hostTauri.testHarness.ts`（删死代码）
- **判据**：`grep -rn "only available in the Tauri desktop runtime" packages/agent-core/src` 归零，
  替换为「当前宿主未提供 workspace 桥」（用户可见文案保持中文）。**`workspaceDialog.ts` 的那处也改**——
  它虽然仍走 `@tauri-apps/plugin-dialog`（未决项 U-1），但文案描述的是「当前宿主没有这个能力」，
  与桥无关，措辞该跟其余一致。
  **两个测试脚手架导出已确认零消费方**（主会话验收 H4d-2 时 grep 过，剩余命中全是注释里的提及）：
  `hostTauriBridgeMock` 直接删；`stubTauriHostFlag` 切的是 `globalThis.isTauri`，而 `isTauriHost()`
  如今只剩 `workspaceDialog.ts` 一个消费方——**删还是留由本卡判断并写明理由**，留就要说清谁将来会用它。
  跑 `pnpm exec vitest run packages/agent-core` 全量
- **模型**：sonnet
- **状态**：DONE `9dc5707`。两个脚手架导出都删了（`stubTauriHostFlag` 的留白理由写进文件头：
  `workspaceDialog.ts` 将来要补测试就沿用 `index.smoke.test.ts` 那套自包含写法，真出现多个消费方
  再抽公共 helper），文件 114 → 62 行、只剩 `hostBridgeMock` 一个导出。另连带修了两个断言旧文案的
  测试（`index.smoke.test.ts`、`toolContext.test.ts`，后者真实调用 `ctx.runShell` 未 mock）。
  **主会话验收时统一了措辞**：交回时 14 处写「未提供 workspace 桥」、shellCommand 那处写
  「未提供 shell 命令桥」——而桥只有一座（`hasHostBridge()`），两个名字会让模型以为
  「shell 桥没了但 workspace 桥也许还在」，白跑一轮文件工具；且那座桥本来也不叫 workspace 桥，
  它承载所有本机命令。已全部统一为「当前宿主未提供命令桥」。

---

## N · host-node 薄包装区

### N1 · 建 host-node 包骨架与路由表契约

- **依赖**：H1
- **改动面**：新建 `packages/host-node/`（package.json、tsconfig、`src/createNodeHostInvoke.ts`、
  `src/commandNames.ts`）；同步 `vite.config.ts` 的 alias、`tsconfig.app.json` 的 paths、
  `scripts/check-boundaries.js` 的 `capabilityPackages`
- **判据**：`createNodeHostInvoke(options): HostInvoke` 返回一个按 command 名分发的路由表，
  未实现的命令返回明确的「未实现」而非静默失败。路由表里**先落一条 `get_user_home_dir`
  → `os.homedir()`**（H4d 拆卡时并进来的，见 H4d-2；N7 读 `~/.webAgent/config.json` 也要用它）。
  **明确不要**把主目录塞进 `/api/health` 让 B1 顺手取走——那会把权威重新劈成两处。**包不依赖 `@web-agent/core` 的运行时**
  （只 import type），不含任何 HTTP。跑 `node scripts/check-boundaries.js` + `pnpm build`
- **模型**：opus
- **状态**：DONE `c9ff758`。900 行 src / 11 例。`NODE_HOST_COMMANDS_BY_DOMAIN` 的**键就是目录名**，
  所以命令表同时是目录规格；命令名联合类型从表推导，不手写第二份。入参形状因 300 行上限拆成
  `commandArgs.ts` + `commandPayloads.ts`，两者间有**双向编译期穷举断言**——命令集合与入参表任一头
  漏一条，`pnpm build` 当场红。门禁生效性也被验证过：子 agent 临时放了个 import 工具域的探针文件，
  确认 `能力包禁入工具域` 真的报错后删除。施工须知见上面「现状事实」新增的那一节。

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
- **状态**：DONE `04a8fa5`。8 个源文件 + 7 份 colocated 测试（61 例），最大 158 行。
  Rust 侧那条 confinement 判定散在六份路径文件里各抄一遍，Node 收成一份，但**保留两种形态**
  ——读取形态（目标必须已存在、靠 realpath 断案、有 `allowExternalPaths` 特权）与写入形态
  （目标可能尚不存在、`../` 词法直接拒、回溯到最近已存在祖先再 canonicalize、**无**外部路径特权，
  因为「读到根外只是看见，写到根外是改别人磁盘」）。
  **两处技术发现已由主会话独立复现**：
  ① **前缀陷阱**——Rust 的 `Path::starts_with` 是**按分量**比的，`/ws-evil` 天然不以 `/ws` 开头；
  直译成 `startsWith` 就把这条性质丢了。判定一律在分隔符边界上比。
  ② **Node 的 realpath 有两种语义**——`fs.realpathSync`（JS 实现）先按词法消 `..` 再走链接，
  而 `fs/promises` 的 `realpath` 与 `realpathSync.native` 走 POSIX 语义（先解链接再吃 `..`），
  **只有后者等价 Rust 的 `fs::canonicalize`**。实测同一个 `link/../real/inner.txt`：JS 版抛 ENOENT，
  native 版解出真实文件。同理拼接不能用 `path.join` / `resolve`（它们会先消 `..`）。
  **变异验证**：删掉 `inheritPermissions` 的 chmod → 两条权限用例失败；把边界判定换成裸
  `startsWith` → 四条前缀用例失败。共 6 条定点失败后完整还原。
  **一处有意偏离 Rust**（见 W16 卡面）：UTF-8 分块解码修掉了 Rust 的坏字 bug。
  另有三处主动与 Rust 保持一致并写明理由：错误文案保留英文原文（两个宿主对同一次越界必须说
  同一句话）、rename 后不 fsync 父目录（要加两边一起加）、边界比较不做大小写折叠（fail-closed）。

### N3 · shell 执行

- **依赖**：N2
- **改动面**：`packages/host-node/src/shell/`
- **判据**：对齐 `apps/desktop/src/shell*.rs`（618 行）：平台 shell 选择、timeout、
  stdout/stderr 上限截断、后台进程登记与 wait/kill。命令 `run_shell_command` 的入参与返回
  逐字段对齐 core 的 `ShellCommandInput` / `ShellCommandResult`。
  跑 `pnpm exec vitest run packages/host-node/src/shell`
- **模型**：opus
- **状态**：DONE `711e032`。9 个源文件 + 5 份测试 / 39 例。
  **卡面前提被推翻且推翻得对**（主会话已复核）：我从文件名 `shell_wait.rs` 推断存在跨调用的
  后台进程表，实际那 75 行只等**本次调用的直接子进程**退出、超时就杀，整个 `shell*.rs` 零跨调用
  状态。所以 Node 侧同样零状态、不开 `hostOptions` 槽位。
  stdout / stderr **都用 drain**（`shell_output.rs` 的 `read_capped_into` 到上限后继续 read 只丢内容，
  两条流共用）——这不是可选项：管道缓冲只有几十 KB，读端一停写端就卡在 write 上，
  「输出超上限」会变成「命令挂到超时被杀」，`exit_code` 从 0 变 null。有专测用例，换成 stop 立刻红。
  **四处 Node 特有的必要偏离**：① 放弃读线程时 Rust 是丢 JoinHandle 让线程与 fd 一起泄漏，
  Node 必须 `stream.destroy()`，否则活着的 Readable 会让 CLI 宿主拒绝退出；② `detached` 而非
  `process_group(0)`（Node 只暴露前者，且 Windows 上语义完全不同，故只在非 win32 设）；
  ③ **env 是合并不是替换**——Rust 的 `Command::envs()` 往继承环境里加，Node 的 `env` 选项整份替换，
  照抄写法会让子进程丢掉 PATH，症状是「传了 env 就找不到任何可执行文件」；
  ④ 存在性检查用异步 `stat` 而非 `existsSync`（这张表要挂在 HTTP 后面，同步 IO 会卡事件循环）。
  **另记一笔既有的误导性文案**（桌面端今天就有，改动要 core + Rust 一起动）：超时命令的
  `exit_code: null` 被 core 的 `normalizeResult` 整形成 `-1` 并追加
  `run_shell_command returned a response without a valid exit code`——对模型来说「超时被杀」
  被说成「桥返回了非法响应」。

### N4 · git diff

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/git/`
- **判据**：对齐 `apps/desktop/src/workspace_git*.rs`（594 行）。**参数白名单必须照搬**
  （`workspace_git_args.rs` 与 `workspace_git_args_tests.rs`）——它挡的是经 diff 参数注入
  任意 git 子命令。跑 `pnpm exec vitest run packages/host-node/src/workspace/git`
- **模型**：opus
- **状态**：DONE `773e0d4`。7 个源文件 + 5 份测试 / 71 例（用真 git 仓库，不 mock）。
  **白名单是构造式不是过滤式**：argv 里每个 flag 都是源码字面量，调用方只能影响 `base` 与
  `paths` 两个值。逐条拒绝各挡什么已写进注释，其中一条**是子 agent 自己补的**、Rust 注释里没有：
  `base` 必须解析成 `^{commit}`——`git diff <x>` 里的 `<x>` 若不是 rev，git 会把它当 **pathspec**，
  少了这步，一个恰好是仓库内路径的 base 会让「对比某提交」静默变成「只看某文件」。
  它还诚实指出「base 含空白/控制字符」这条**在没有 shell 的前提下不是拆词防线**（`spawn` 不带
  `shell`，argv 直接 execve），挡的是另外两件次要的事，但没有因此放宽它。
  **env 三件套有行为验证而不只是断言配置存在**（主会话复核）：仓库 config 里配一个会 `touch`
  标记文件的外部 diff driver，断言标记文件不存在、且 diff 内容仍是 git 自己算的那份。
  路径 confinement 没有复用 common 的两个 `resolve*`（那两个产出绝对路径给系统调用，这里要的是
  给 git 的相对 pathspec，且必须允许目标已被删除），照搬 `workspace_git_path.rs` 自己那套。

### N5 · rg 搜索

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/rg/`
- **判据**：对齐 `apps/desktop/src/workspace_rg.rs`（486 行）：spawn `rg --json`、上下文行、
  `maxMatches` 上限与 truncated 标记、stderr 截断、`--max-filesize=1M`。rg 缺失时返回可读错误
  而非崩溃。跑 `pnpm exec vitest run packages/host-node/src/workspace/rg`
- **模型**：sonnet
- **状态**：DONE `9410ab5`。9 个源文件 + 5 份测试 / 54 例。六个常量逐值对齐（主会话复核），
  `maxMatches` 与 `contextLines` 超限一律**钳到 MAX 不拒绝**，`maxMatches` 为 0 或缺席回落 DEFAULT
  （0 不表示无限）。解析 `match` / `context` 事件，忽略 `begin` / `end` / `summary` 与解析不了的行
  ——与 Rust 的 `_ => {}` 逐条一致。
  **stdout 既不用 stop 也不用 drain**：走 readline 逐行解析并按 maxMatches 自行停止（Rust 的
  `parse_rg_stdout` 同样没用那两个共享 helper）；只有 stderr 用 `readCappedDrain`，必须与 stdout
  并发排空，否则 stderr 管道写满会把子进程堵死。
  **rg 缺失的文案在 Rust 原文后追加了中文安装提示**（Rust 原文没有可抄的）——前缀逐字保留，
  是增量信息不是改写，基于前缀的断言不受影响。
  **一处继承自 Rust 的行为要让调用方知道**：不传 `path` 时 rg 的 target 是 `.`，于是它给每个
  结果路径加 `./` 前缀（对真实 ripgrep 15.1.0 实测过），`normalize_display_path` 只剥绝对路径、
  不剥这个前缀。不是 bug，但默认搜索的调用方要预期到。

### N6 · run workspace task

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/task/`
- **判据**：对齐 `apps/desktop/src/workspace_task.rs`（480 行）：按 kind 发现并执行
  测试/lint 命令、输出上限、退出码透传。跑 `pnpm exec vitest run packages/host-node/src/workspace/task`
- **模型**：sonnet
- **状态**：DONE `40cb560`。7 个文件 / 59 例。kind（test / build / lint / typecheck）映射到同名
  `package.json` script，包管理器按 lockfile → `packageManager` 字段 → npm 逐级探测；
  `cargo_check` 依次找根 `Cargo.toml` → `apps/desktop/` → `src-tauri/`。
  **三个模块的 capped 读各不相同**（子 agent 先按 git 的类比假设 stdout 用 stop，自己 grep 后
  推翻，主会话复核确认）：`workspace_task.rs` 两个流**都用 drain**、`workspace_git_exec.rs`
  是 stdout=stop + stderr=drain、`workspace_rg.rs` 的 stdout 走逐行 JSON 解析不经 capped。
  task 用 drain 是对的——chatty 的构建/测试工具 stdout 到上限后若停读会背压卡死，反而制造假超时。
  **一处有意偏离**：Rust 的 timeout 分支用同步 `try_wait` 区分「kill 失败但进程其实已自然退出」
  与「kill 失败且仍在跑」；Node 的事件式实现里这个竞态**结构上不存在**（自然退出先 resolve 并
  `clearTimeout`，kill 分支只在进程确实还活着时才跑），故不复刻，理由写在 `taskProcess.ts` 文件头。

### N7 · 用户配置读写

- **依赖**：N1
- **改动面**：`packages/host-node/src/config/`
- **判据**：对齐 `web_agent_config_store.rs` + `web_agent_config_write.rs`：默认
  `~/.webAgent/config.json`；**新文件不存在时才**安全复制旧 `~/.web-agent/config.json`，
  新文件优先且旧文件保留；`WEB_AGENT_CONFIG_DIR` 只选目录、**不接受也不返回模型 Key**；
  设置覆盖目录时不触发迁移。Unix 下配置目录权限 0700。
  跑 `pnpm exec vitest run packages/host-node/src/config`
- **模型**：opus
- **状态**：DONE `c0b054d`。7 个文件 / 57 例。**凭证边界由主会话独立探针验证**：喂一份含
  `modelCredentials.deepseek = "sk-…"` 的配置，`mcp_config_read` 的返回里既无该 Key 也无
  `modelCredentials` 键名，而 `mcp` 段照常返回。设计理由也对——底座不认任何一段的内容，段视图
  请求的段名恒为 `mcp`，凭证拿不到不是因为某处写了过滤，是它根本不在返回路径上。
  `merge` 语义是**顶层浅合并 + null 删键**（两条互相排除的用例 + 变异测试钉住：改成整份替换
  或去掉 null 分支都会转红）。迁移四分支里最漂亮的一条：设了 `WEB_AGENT_CONFIG_DIR` 时
  `legacyPath` 恒为 `undefined`，**迁移在机制上不可能发生**，而不是靠某处记得写 if。
  **五处没照搬 Rust，各有理由**：① 加一条全进程写入串行队列——Rust 的 `static CONFIG_LOCK`
  只挡跨线程，Node 单线程但读—改—写中间隔着两次 await，两个并发 write 会各读旧值各写回；
  ② 补丁里值为 `undefined` 的键当作没写（Rust 无此分支，因为 Tauri 收的是已反序列化的 `Value`）
  ——不跳过就是「本地删得掉、上 server 删不掉」；③ 临时文件名用进程内自增序号（Node 无同口径
  纳秒时钟，`Date.now()` 同毫秒两次写入会撞名）；④ 缺 `patch` 的报错是新写的（Rust 那层由 Tauri
  反序列化挡住）；⑤ 只排顶层不递归排序（纯排版，为的是两个宿主轮流写同一份文件时不产生整份 diff）。
  **不复用 N2 的 `atomicWrite`，理由成立**：Rust 侧同样是两份实现，权限语义相反——workspace 那份
  显式**继承原文件权限**（否则覆盖会抹掉脚本可执行位），配置这份强制 0600 / 目录 0700。
  合成一个带开关的函数等于让调用方每次现选一次安全级别，漏选那次不报错、只让凭证变成同机可读。

### N8 · CLI 注入进程内 host

- **依赖**：H5、N3、N4、N5、N6、N7
- **改动面**：`apps/cli/src/runtime.ts`
- **判据**：**本线试金石**。注意 CLI 至今没有桥（H5 交回时点名）——这**不是回归**（Node 里没有
  `globalThis.isTauri`，`isTauriHost()` 在 H1 之前也一直是 false），而是本卡要补的那个缺口本身：
  在此之前 CLI 的文件 / shell 工具对模型一直不可见。
  `configureHostInvoke` 在 `registerStandardTools` 之后调用。
  **判据已按实际进度收窄**（原文要求验证「列文件 + 读 package.json」，但 read 域属 W1–W4、尚未落地）：
  当前路由表已实现 shell / git / rg / task / config 五域，本卡验的是**接线本身**——
  `hasHostBridge()` 在 CLI 启动后为 true、`run_shell_command` 能真的执行、
  未实现的 `read_workspace_file` 报的是「Node 宿主尚未实现」而**不是**「当前宿主未提供命令桥」
  （两者的区别正是这张卡的价值：桥接上了，只是某些域还没填）。
  文件工具的端到端验证随 W 线完成后补一张验收卡。跑 `pnpm exec vitest run apps/cli` + `pnpm build`
- **模型**：opus
- **状态**：DONE `8586159`。**N 线试金石通过。** 主会话独立端到端探针：装配桥之前
  `runShellCommand` 答「当前宿主未提供命令桥」，`configureHostInvoke` 之后同一调用
  `exitCode: 0` 且 stdout 含预期标记——core → 桥 → host-node → 真子进程这条链路打通。
  子 agent 自己的验证也没偷懒：判据 3 不只断 `exitCode === 0`（normalize 的兜底路径也能凑出
  体面的结果对象），而是让 shell **落一个只有真子进程做得出的痕迹**再用 `node:fs` 读回来，
  顺带证了 cwd 送对了。
  `homedir()` **保留在 CLI 侧并提升为进程内唯一权威**，经 `homeDir` 槽位注入给桥：CLI 自己就是
  那台机器，主目录这个事实由它产出；反过来向桥要等于绕一圈问自己，还凭空多一个会漂移的权威。
  **诚实标注的未验证项**：没有模型 Key、没跑真实一轮，「模型在 CLI 里看得见 shell 工具」是从
  `hostHasLocalCapabilities = hasHostBridge()` 推出来的，不是端到端观测到的。
  另：`apps/cli/package.json` 一改就必须同步 `pnpm-lock.yaml`（CI 的 desktop 作业用
  `--frozen-lockfile`，web 作业不带该 flag 所以不会暴露）。

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
- **状态**：DONE `cde7899`。6 个文件 / 36 例。
  **哈希做了跨语言实跑对拍**：临时建了个只依赖 `sha2 = "0.10"`（与 `apps/desktop/Cargo.toml` 同版）
  的 crate 逐字抄 `content_sha256`，对四个样本与 Node 的 `createHash('sha256').digest('hex')`
  逐字符比对、全等，期望值钉进测试并注明来源（不是「跑一遍 Node 记下来」）。主会话复核了三个值，
  其中 `"abc"` 那条是 FIPS 180-4 公开向量。编码另有三处闭合背书：两个 guard 只收
  `sha256:<64 lowercase hex>`，core 的 `normalizeReadResult` 用同款正则过滤，而 `{:x}` 是小写 hex。
  **一个会静默错位的坑：`TextDecoder` 必须显式 `ignoreBOM: true`。** Node 默认把开头的 U+FEFF
  当 BOM 吃掉，而 Rust 的 `from_utf8` 原样保留——不设这个选项，带 BOM 的文件在 Node 侧少 3 字节，
  `bytes` / `nextOffset` 整体错位、续读从错误位置开始，**全程不报错**。而且选项名是反的
  （`true` = 不把 BOM 当特殊字符），极易写反。主会话实测确认：默认解出 2 字符，
  `ignoreBOM: true` 解出 3 字符。
  分页无损这条地基没有只靠读代码：`decodeUtf8` 做了 **4060 个样本的差分测试**，
  Rust `from_utf8` 与 Node 流式 `TextDecoder` 的分类与 `valid_up_to` 全等。
  **`nextOffset` 到文件尾时是「键不存在」**，不是 `undefined` 也不是 0；它与 `truncated` 共用
  `offset + bytes < totalBytes` 这一个判据，所以「最后一段正好读满 `maxBytes`」时 `truncated`
  仍为 false——它判的是「还剩没剩」，不是「这次有没有触上限」。
  **一处照搬但值得两边一起改的**：错误消息里用绝对路径（Rust 的 `display_path`），而返回值的
  `path` 是根相对——一次读失败会把宿主机绝对路径写进模型可见的错误文本。属跨语言对拍
  （W16/W17）该拿的决定，本卡未单方面改。

### W2 · 文件读：行寻址

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/lines*`
- **判据**：对齐 `workspace_read_lines.rs`：`startLine` / `lineCount` / `endLine` / `nextLine` /
  `totalLines`；`startLine` 与非零 `offset` 互斥的拒绝路径有测试。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `65d781a`。4 个文件 / 71 例（read 域合计）。W1 的文件一字未动。
  **⚠️ 接线时注意**：`read_workspace_file` 唯一该注册的是 `linesDispatch.ts` 的
  `createReadWorkspaceFileHandler`，**不是** `bytesRead.ts` 的字节版——挂错的症状是行参数被**静默
  忽略**（模型传 `startLine` 却拿到从头 20 KB，不报错）。
  **分派判据**：`start_line` 与 `line_count` 两个都没给才走字节模式（任一个都触发行模式，
  只给 `lineCount` 时起始行默认 1）；进了行模式后 `offset` **大于 0** 才算冲突——
  **`offset: 0` 不算传了**（Rust 是 `offset.is_some_and(|v| v > 0)`）。
  **一处 JS 直觉会写错的地方**：空文件是 **0 行**不是 1 行，而 `''.split('\n')` 给 `['']`（1 段）
  ——照着写会让 `startLine: 1` 读空文件返回空内容，而 Rust 报
  `startLine 1 exceeds the file's 0 line(s)`。子 agent 没用 `split`，另写 `lineBoundaries` 复刻
  `str::split_inclusive('\n')`。主会话已复核这个差异真实存在。
  行的其余定义：末行无换行仍算一行；`\r\n` 不额外成行、`\r` 留在所属行内容里；裸 `\r` 不是分隔符；
  行尾原样保留（这是「读出来的内容能直接当 `apply_patch` 的 oldText」的前提）。
  `nextLine` 与字节模式的 `nextOffset` **完全同款**：三字段共用 `servedAll` 一个判据，
  只在还有剩余时才存在这个键。
  行模式的 `contentHash` 只看 `startLine === 1`（截断时也给），没有字节模式那条「8 MB 以上不给」
  的分支——因为定位第 N 行必须先看过前面所有字节，超 8 MB 在读之前就整体拒绝了。
  **四处照搬并记录**：冲突文案与判据不贴合（只给 `lineCount` + 非零 offset 时报的是
  "pass either offset or **startLine**"）；错误消息用绝对路径（清单第 5 条）；
  `startLine` 越过末行是**硬错误**而字节模式 `offset == totalBytes` 返回空段，两者不对称；
  行模式每次调用整文件读入并重新切行，顺着 `nextLine` 走完大文件是 O(n²)（有 8 MB 硬顶兜着）。

### W3 · 目录列举与文件名搜索

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/list*`、`search*`
- **判据**：对齐 `workspace_read_list.rs` + `workspace_read_search.rs`：`recursive` /
  `maxEntries` / `includeHidden`；**不递归进 symlink**。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `180c89d`（与 W4 合成一枚——两卡并发追加了同两个共享文件，强行拆开会让某一枚
  带上另一卡的常量）。read 域 registrar 与接线 `26b72a7`。
  **symlink 有三种处理，不是一种**：realpath 成功且在根内 → **列出但不进去**（entry type 取自
  `lstat`，对 symlink 恒非目录，所以 `recursive: true` 也不会递归进去）；**dangling symlink
  整条不列**（canonicalize 失败）；目标越界的也整条不列（除非 `allowExternalPaths`）。
  `maxEntries` 是**硬停**：检查排在隐藏/越界过滤之后、push 之前，所以被过滤掉的条目既不计数
  也不触发 truncated；一旦触顶立即中止整个递归，不会读完当前目录。
  `includeHidden` 判据是名字以 `.` 开头，**隐藏目录整个子树跳过**——里面的非隐藏文件也不可见，
  因为那个目录压根没被进入。
  搜索的「glob」**刻意不是 glob**：四个字面前缀分支（`*prefix` 剥一个前导 `*` 后缀匹配 /
  `.ext` 后缀匹配 / `*` 在中间则**剥掉全部 `*` 做纯子串匹配、完全忽略位置** / 否则纯子串），
  全程大小写敏感。
  **两处照搬的、容易被误认成 bug 的行为**：① 目录读失败（如权限不足的子目录）中止**整条命令**
  而不是跳过那个子树；② 搜索时单个文件打开/读取失败同样中止**整个搜索**——一个 `chmod 000`
  的文件放在搜索根下的任何位置都会让整条搜索报错。这与「二进制/非 UTF-8 内容」不同，后者两边
  都是逐文件软跳过。子 agent 专门写了测试钉住 ②，并在报告里点名以免评审时误判。

### W4 · run index 分页读

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/read/runIndex*`
- **判据**：对齐 `workspace_read_run_index.rs`：JSONL 游标分页、`snapshot` 标识、`hasMore`。
  跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `180c89d`（与 W3 合枚，见上）。17 例。
  `snapshot` 形态是 `v1-<byteLen>-<16 hex>`，游标是不透明串 `{snapshot}:{before}`，`before` 是
  行数组的 0 基开区间上界（**不是字节偏移也不是行号**），解析用 `lastIndexOf(':')` 对齐 Rust 的
  `rsplit_once`。三种失败分开：语法非法 → `run index cursor is invalid` / `...version is
  unsupported`；语法合法但 `before` 越界 → `run index cursor is out of range; refresh history`；
  snapshot 不匹配 → `run index changed while paging; refresh history`。
  `hasMore` 为 false 时结果**不带 `cursor` 键**（不是 `undefined`），有 `'cursor' in page === false`
  的测试。
  JSONL 行切分**没有复用 W2 的 `lineBoundaries`**：那个复刻的是 `split_inclusive('\n')`（保留换行、
  给分块续读用），而 run index 要的是 `str::lines()` 语义（去掉换行、末尾 `\r` 也去、结尾换行
  不制造幻影空行）。两者只在文件末尾处不同，所以各写一份是对的。
  **一处有意的算法偏离**：没复刻 Rust 的 `DefaultHasher`（SipHash13），改用 sha256 前 16 hex。
  子 agent 给的理由是「Node 从不验证 Rust 铸的 cursor」——**这个断言过强**，主会话修正为：
  当前两个宿主的会话数据本就不共享（桌面 SQLite / Web IndexedDB），所以跨宿主 cursor 不会出现；
  **即使 P 线把持久化收敛后真的出现**，失败形态也是 `run index changed while paging; refresh
  history`，模型重新从头翻页，是设计好的降级路径而非数据损坏。结论可接受，但 **P3 落地时要回来
  重新评估这处**。

### W5 · 文件写：目标路径解析与限额

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/write/targetPath*`、`limits*`
- **判据**：对齐 `workspace_write_target_path.rs` + `workspace_write_limits.rs`。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `488fe5d`。targetPath **只有 49 行**——N2 已经把写入形态该做的四件事全移植进
  `resolveWorkspaceTargetPath`（自己 trim 加空串拒、词法直接拒 `..`、最近已存在祖先 canonicalize
  后比边界、**签名里根本没有** `allowExternalPaths`），本卡是把底座两块拼起来、不重抄判定，
  逐条对应关系写在文件头免得后人以为漏了什么。
  **判定时机**：写之前按**实测字节数**拒——既不是按声明的大小，也不是边写边数
  （`workspace_write_pipeline.rs:133-159` 先把 content 解成完整 payload 再比上限），所以调用方
  谎报大小无效，也不存在半截文件。且这个检查排在路径解析**之前**，因此超限失败的 `path` 字段
  是**原始入参**而非 displayPath——W7 拼流水线时要保住这个顺序。
  **一处直译就会错的地方**：可逆预算判定用 `Buffer.byteLength` 而非 `.length`，因为 Rust 的
  `String::len()` 是字节数；直译成 `.length` 会让 1.2 MB 的中文正文被判成「没超 1 MiB、可逆」
  再整份塞进变更日志。有专测钉住。
  **发现 Rust 一处文案与常量对不上**：`workspace_write_before.rs:44` 的
  `existing file exceeds reversible {MAX_BYTES} byte limit` 里 "reversible" 与它实际用的
  `MAX_BYTES`（8 MiB 硬顶）不符，该是 `REVERSIBLE_MAX_BYTES`（1 MiB）。**照搬未改**——
  错误文案是两个宿主的对外契约，改一个字就是制造分叉；要改该走 Rust 侧。

### W6 · 文件写：进程内与跨进程写锁

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/write/lock*`
- **判据**：对齐 `workspace_write_lock.rs`：进程内按目标路径的互斥表（含扫除阈值）+
  跨进程锁文件（`create_new` 抢占、token、心跳、stale 超时接管）。
  必须有「两个并发写同一路径被串行化」的测试。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `3d71aea`。4 个源文件 + 4 份测试 / 57 例。
  **进程内锁在 Node 里同样必要**，理由说得很准：单线程消掉的是数据竞争，消不掉**跨 await 的
  交错**。临界区是「读 before → 比 hash → 记回滚日志 → atomicWrite」，中间至少两次让出；
  A 在读 before 处让出、B 整段跑完把文件换了，A 恢复后拿**自己那次读到的** before 去比乐观守卫
  ——比的是过期快照当然通过——然后整份覆盖。**守卫存在的意义就是拦「你读完之后有人改过」，
  没有锁时它恰恰只会拿自己的旧读数自证清白。**
  API 收成 `run(key, operation)` 而非照搬 Rust 的「返回一把锁自己 lock」：Rust 靠 guard 的 Drop
  释放，JS 没有 Drop，`acquire`/`release` 写在两处时任何一条 early return 都能让那个路径永久死锁。
  `holders` **在排队时就加**（等待者也算持有者），否则扫除会删掉一条还有人排队的条目、
  后来者新建空队列就并行了。
  **stale 接管用改名而非直接 unlink**：两个等待者同时判陈旧时直接删会让 B 删掉 A 刚建好的锁；
  改名目的地带各自 token 必不同名，rename 成功的才算接管。释放时先比对 token 再删。
  **测试设计里有一条对照组**，值得后续卡照抄：主断言是「加锁后临界区 peak === 1」，但那可能
  只是因为临界区根本不让出——所以同文件里放了一条不上锁跑同一段临界区、断言 `peak === 2` 的
  对照组，外加一条「不同路径 peak === 2」钉粒度（退化成一条全局队列时前面几条依然全绿，
  只有它会红）。另做了 5 项变异验证，逐项列出哪些测试变红。
  **一处技术主张经主会话实测不成立**（做法对、理由错，代码未改）：它称「测试环境是 jsdom，
  全局 `setInterval` 返回的 number 上没有 `unref`，真调是当场 TypeError」，实测本仓库的
  vitest + jsdom 下全局 `setInterval` 返回的是 `object/Timeout/unref=function`。从 `node:timers`
  显式导入这个做法仍然正确——它不依赖环境全局是什么，换 happy-dom 或真浏览器环境就会坏。
  **一处它自己标注「测试盯不住」的改动**：锁年龄算成 `Date.now() - Math.floor(mtimeMs)`，
  因为两个读数精度不同（`Date.now()` 只有毫秒、`mtimeMs` 带纳秒小数），直接相减会得到
  「未来的 mtime」。实测去掉 floor 跑 5 遍仍全绿——20ms 轮询盖住了它——所以理由只能写在注释里。
  **一处 Rust 文案未移植**：`failed to initialize archive lock heartbeat` 对应 Rust 的
  `file.try_clone()` 失败，而 Node 侧初始写与心跳共用同一个 `FileHandle`、没有 clone 这一步，
  留着就是一句永不出现的文案。其余四句逐字保留。
  **给 W7 的交接**：`release()` 必须由调用方在 `finally` 里调（JS 没有 Drop），是那一层的责任。

### W7 · 文件写：乐观守卫与主流水线

- **依赖**：W5、W6
- **改动面**：`packages/host-node/src/workspace/write/guard*`、`pipeline*`
- **判据**：对齐 `workspace_write_guard.rs` + `workspace_write_pipeline.rs`：
  read-verify-write，`contentHash` 不匹配时拒绝覆盖并返回可操作错误。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `30f95ff`。13 个源文件 + 10 份测试 / 121 例（write 域合计 178）。全树最大一张。
  流水线 13 步的顺序表已在报告里逐条对齐 Rust，其中三条是**顺序本身就是契约**：
  content 解成完整字节比上限**排在路径解析之前**（所以超限回执的 `path` 是原始入参，
  有用例拿 `'./out.txt'` 钉住，把限额挪到后面当场红）；读 before **只读一次**、守卫/日志/摘要
  三方共用；`prepareChangeSet` 记账在落盘之前。**失败要撤的动作只有一个**——已预留的变更集
  （写盘或 executable 失败 → `discardPreparedChange`，dry run 同样丢）。
  **守卫不匹配给的是结构化回执不是 rejection**：`expectedOldContent` 不匹配时带
  `expected_bytes` / `current_bytes` / `first_mismatch_byte` / `expected_trailing_lf` /
  `current_trailing_lf` 五个数字，**全按 UTF-8 字节算**——`.length` 直译会让中文内容报出实际值
  1/3 的位置。`expectedContentHash` 不匹配则**不回传当前实际 hash**，照搬 Rust。
  **子 agent 纠正了自己初稿的一处错误说法**：不是「先 chmod 等于什么都没做」，准确版本是
  `create` 时文件还不存在会 ENOENT、`overwrite` 时先 chmod 反而会被 `atomicWrite` 原样继承——
  所以「写完之后」是唯一对四种模式都成立的位置。
  跨进程归档锁的 `release()` 包在临界区**外面**的 `finally` 里，异常/结构化拒绝/正常返回三条
  路径都过。三次变异验证：去掉 `withPathLock` → 并发用例变成「两个守卫都通过」当场红；
  限额挪到路径解析之后 → path 用例红；去掉写失败时的 discard → 孤儿账用例红。
  **base64 的 seam 刻意留成结构化拒绝而不是用 `Buffer.from(x,'base64')` 顶**（W8 接手）：
  后者对非法字符**静默跳过**，`"not base64!"` 会被解成垃圾字节写进磁盘，比拒绝糟。
  **两处 Node 侧无对应出口**：`mark_change_applied` 失败 Rust 打 warn、Node 只能吞（回执仍 ok，
  账停在 `prepared`，回滚照样认）；`WorkspaceWritePerf` 的分阶段耗时日志整段未移植。

### W7b · 把 change summary 合并进 workspace/common

- **依赖**：W7（`30f95ff`）、W13（`b169754`）
- **改动面**：新建 `packages/host-node/src/workspace/common/changeSummary*`；删除
  `workspace/write/changeSummary.ts` + `changeSummaryDiff.ts` 与 `workspace/patch/changeSummary.ts`
  + `lineDiff.ts`；改两域的 import 与测试
- **判据**：**来源：W7 与 W13 并行时各自实现了一份 `compute_change_summary`。** Rust 侧那个住在
  `workspace_common.rs`、被 write 与 patch 共用（`workspace_patch_pipeline.rs:93`），两卡都不敢在
  common 建同名文件（后落笔的会静默盖掉先落笔的），所以各留了一份。
  **两份的行为已确认一致**（主会话复核）：W13 在对照 W7 时发现自己的 `splitLines` 无条件剥末尾
  `\r` 是错的、已改成与 W7/Rust 同款（只剥真正位于换行符之前的）。合并时仍要**逐条对照再落笔**，
  别默认哪份对——两份的导出面不对称（patch 版导出 `splitLines`，write 版是私有函数）。
  合并后两域的测试都要仍然全绿，且 `computeChangeSummary` 的用例合并去重而不是删掉一半。
  跑 `pnpm exec vitest run packages/host-node` + `node scripts/check-boundaries.js`
- **模型**：sonnet
- **状态**：DONE `dd3f2e4`。128 增 311 删（净减 183 行），git 识别出了文件移动。
  **逐条对照的结论**：算法、常量（`DIFF_MAX_LINES=60`、`DIFF_LCS_BUDGET=800×800`）、渲染格式、
  返回形状、**LCS 回溯取等号的方向**（`>=` → 优先记 remove）两份完全相同；唯一实质差异就是卡面
  已知的 `splitLines` 尾部 `\r`，而提交时两份都已带修复，所以合并时行为已一致。
  公开面取**并集**：`splitLines` 与 `DiffTag` 现在导出（此前只有 patch 版导出），理由写在
  `lineDiff.ts` 头——`\r` 那个边界够微妙，值得能直接单测而不必绕经 `computeChangeSummary`。
  测试 26 → 23，**去掉的 3 条是真重复**（941 = 944 − 3，账对得上），且每对重复都保留了断言更强的
  那条：全对象 `toEqual` 的、检查确切渲染串的、断言更多字段的。两份各自独有的用例全部保留，
  包括两条 LCS 预算超限用例（801 行与 1200 行断言的性质不同：删-加顺序 vs 截断长度与文案）。

### W8 · 文件写：base64 二进制写入

- **依赖**：W7
- **改动面**：`packages/host-node/src/workspace/write/base64*`
- **判据**：对齐 `workspace_write_base64.rs`：解码失败明确报错，不写出半个文件。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `911fa14`。2 个新文件 + 3 处改动，write 域 178 例。
  **`Buffer.from(x, 'base64')` 的危害经主会话实测确认，比预想更糟**：
  `Buffer.from("not base64!", "base64")` **不报错**，产出 6 个垃圾字节 `9e8b5b6ac7ba`。
  模型若忘了编码直接传原文，这 6 字节就会被写进磁盘而回执说成功。
  **做法是逐字状态机移植**，不是「regex 预校验 + Buffer.from」也不是「解码后 round-trip 比对」：
  前者让校验规则与解码逻辑分成两套、会各自漂移；后者仍要先 `Buffer.from` 把垃圾解出来再发现
  不一致。状态机单遍消费，非法符号（含落在非尾部的 `=`，如 `"Z=g="`）在**任何字节产出之前**
  就抛，不存在能让非法字符抵达输出缓冲的代码路径。
  alphabet 是标准 RFC 4648（`-`/`_` 按非法字符拒），padding **可选**但一旦出现则去空白后总长
  必须是 4 的倍数、尾部 `=` 不超过两个；ASCII 空白先剥（含 `\x0C` 但**不含** `\v`，对齐 Rust 的
  `is_ascii_whitespace`）。测试覆盖非法字符、URL-safe 字符、padding 位置错、padding 长度错、
  截断输入、含空白的合法输入、空串（合法，解出零字节）。
  **限额比的是解码后的字节数**（`payload.bytes.length`），且仍在路径解析之前——W7 那条
  「超限时 `path` 是原始入参」的用例原封不动仍通过。
  `recoverPayloadText` 在 base64 路径下的作用：解码后若字节恰好是合法 UTF-8 且无内嵌 NUL，
  `text` 就是那段文本、变更日志照常记并能出行级 diff；否则 `text` 为 `null`，写入照样成功但
  标记为不可逆、无 diff。

### W9 · 文件写：归档 compaction

- **依赖**：W7
- **改动面**：`packages/host-node/src/workspace/write/compaction*`
- **判据**：对齐 `workspace_write_compaction.rs`。跑该目录 vitest
- **模型**：sonnet
- **状态**：DOING

### W10 · 删除路径

- **依赖**：N2、W14
- **改动面**：`packages/host-node/src/workspace/delete/`
- **判据**：对齐 `workspace_delete.rs`（461 行）。删除是不可逆动作，**必须先进 change journal
  再执行**，否则 `revert_workspace_change` 拿不回来。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `b6be655`（registrar 接线 `ba3d939`，与 pathOps 同批）。9 个源文件 + 7 份测试 / 61 例。
  **账里不存内容**：条目只记一条根相对路径（`movedPaths`），内容整份**复制**进
  `<journal>/<changeId>.payload`（删目录时那是一棵完整目录树，含权限位）。
  上限由递归预扫判：`MAX_ENTRIES = 20000`（含目录本身与全部子孙）、`MAX_BYTES = 512 MiB`
  （**只累计文件**，目录项自身 size 不计），边界是 `>`。**超限是拒绝删除，不是标记不可逆**
  ——10 万文件的目录在第 20001 个条目上就停手，一个字节不删、一条账不记。
  **symlink：链接和目标都不删，整次拒绝**，三道防线（逐段 lstat 含最后一段 / pipeline 再判一次
  只在 TOCTOU 窗口可达 / 递归预扫时树里任何一处软链拒整次）。**什么都不记**——拒绝全部发生在
  `prepareDeletedPathChange` 之前，日志目录里连一条 prepared 都不会有。
  **删除侧没有「不记账直接删」这个口子**（write 域有）：缺 `change_context` 直接 `ok:false`。
  理由写在源码顶部——写入的最坏情况是旧内容没了而新内容还在，删除的最坏情况是那份内容
  从世界上消失。
  三条补偿路径已实现，但**后两条没有测试覆盖并已诚实标注**：要在两次系统调用之间注入失败，
  没有 DI 就 induce 不出来（chmod 类做法在 root 容器里失效），Rust 侧同样没测。
  **主动核对了 Rust 问题清单里哪些条适用于本域**（主会话复核）：第 11 条**不适用**——
  `workspace_delete.rs:280` 的 `relative_path` 是**条件式**的（`if MAIN_SEPARATOR == '/'`），
  与读写侧一致、与 patch/path_ops 那两处不一致，本域站读写侧；第 3 条无关（删除走
  `movedPaths` + payload，全程不产生 `FileSnapshot`）。

### W11 · 复制与移动路径

- **依赖**：N2、W14
- **改动面**：`packages/host-node/src/workspace/pathOps/`
- **判据**：对齐 `workspace_path_ops.rs`：源/目标双向 confinement、目标已存在的处理、
  进 change journal。跑该目录 vitest
- **模型**：sonnet
- **状态**：DONE `699c8e1`。5 个源文件 + 3 份测试 / 53 例。
  **又一处 Rust 自成一体的路径解析**（主会话复核：`workspace_path_ops.rs` 只从 common import 了
  `resolve_workspace_root`，`resolve_source`/`resolve_destination` 是它自己的局部函数）——
  而且**比共享的两个形态更严**：它们**直接拒绝绝对路径与 `..`**，而共享的读/写形态是允许写、
  再靠 realpath 断案。至此 Rust 侧已有三处自成一体的路径解析（write / patch / pathOps），
  每处的严格程度都不同。
  **目标已存在**：copy 与 move 判据相同，用 `symlink_metadata`（不跟随的 lstat）查原始拼接路径，
  **dangling symlink 也算存在**；Rust 没有 force/overwrite 参数，故没加。
  **EXDEV 不是特判**：Rust 的 `move_path` 不区分错误类型，**任何** `fs::rename` 失败都回落到
  copy + delete-source，且 delete-source 再失败时清理掉已复制的那份。这段 W14 已经移植过
  （`change/pathOpsMove.ts`），本卡直接复用。
  **目录递归但日志只记一条**：不管子树多大，copy 记一条 `TrackedPath{path, fingerprint}`
  （进 `createdPaths`）、move 记一条 `RelocatedPath{source, destination, fingerprint}`
  （进 `relocatedPaths`），fingerprint 递归哈希整棵子树的结构与内容。
  **`MovedPath` 与本卡无关**——它专属 `prepareDeletedPathChange`（W10 的可恢复删除载荷迁移）。
  **发现一处结构上不可达的死分支**：`source === destination` 的早退检查——目标解析已要求不存在，
  任何会 canonicalize 成已存在源的路径会先被「目标已存在」拦下。照搬保留（无害）。
  第 11 条已知问题（展示路径无条件 `\` → `/`）在本模块照搬，并有专门的测试钉住。

### W12 · patch：路径解析与 stage

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/patch/path*`、`stage*`
- **判据**：对齐 `workspace_patch_path.rs` + `workspace_patch_stage.rs`。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `9939a68`。7 个源文件 + 7 份测试 / 85 例。
  **纠正卡面一个预设**：「目标必须已存在吗」**不在路径层判**——路径解析对四个变体完全一样，
  存在性要求全在暂存规则里按 `FileState` 判。
  四个 operation 变体已逐个核对（`type` 取值 snake_case、载荷字段 camelCase，两层不同款）：
  `add_file`(path, content | executable)、`delete_file`(path | oldContent, expectedContentHash)、
  `replace`(path, oldText, newText | expectedReplacements)、
  `overwrite_file`(path, content | oldContent, expectedContentHash, executable)。
  **两处直译就会静默改写用户内容**（主会话已复现）：
  ① `replace` 必须用 `split().join()` 而**不是** `replaceAll`——后者会把 newText 里的
  `$&` / `$1` / `$'` 当替换模式展开。实测模型想写 `"price is $& and $1"`，`replaceAll` 给出
  `"price is FOO and $1"`（`$&` 被展开成匹配到的原文），**正文被静默篡改**。
  ② `changed_paths` 的排序是 Rust `sort_by_key(String)` = **UTF-8 字节序**，而 JS 默认 `sort()`
  是 UTF-16 码元序，遇增补平面字符顺序相反（实测 `["😀.txt","\ufffd.txt"]` vs
  `["\ufffd.txt","😀.txt"]`）。用 `Buffer.compare`。
  **stage 的中间态**：`Map<绝对路径, {initial, current, executable}>`，`initial` **整批只读一次**
  （第二次读会看见批内前面操作以为改过的内容，而磁盘并没变，`initial` 就不再是回滚依据）；
  操作只改 `current`、磁盘一字不动，所以「任一失败整体不写」是**根本没进落盘那步**而不是回滚。
  真回滚只发生在落盘中途失败（磁盘满/权限），靠 `initial` 逆序还原——那是 W13 的事。
  **越界但合理**：卡面把 `limits*` 划给 W13，但 stage 每个分支第一步就要用那三个校验器，
  故一并实现；`guard.ts` 与 `operation.ts` 树里没被任何卡认领，也一并落了。
  给 W13 的接口面与「校验入参 → 解析路径 → 读磁盘 → 算新状态」的顺序契约已在报告里交代。

### W13 · patch：应用流水线与限额

- **依赖**：W12、W14
- **改动面**：`packages/host-node/src/workspace/patch/pipeline*`、`fs*`、`limits*`
- **判据**：对齐 `workspace_patch_pipeline.rs` + `workspace_patch_fs.rs` +
  `workspace_patch_limits.rs`：全部 hunk 成功才落盘，任一失败整体不写。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `b169754`。8 个源文件 + 6 份测试 / 146 例。W12 的文件一字未改。
  **「任一失败整体不写」的主力不在回滚，而在根本没进落盘那步**（W12 的暂存设计），
  子 agent 用**退化探针表**证明测试不是摆设——四种退化各自让哪些用例变红：
  `if (rejected.length > 0)` 改成 `if (false)` → 3 条红；删掉 rollback 调用 → 3 条红；
  `applyExecutableBit` 挪到 `writeTextFile` 之前 → 2 条红；`commitChanges` 挪到
  `prepareChangeSet` 之前 → 1 条红。
  **失败注入不用 mock**，全是可控的真实文件系统状态：把目标路径的父段先建成**文件**
  （`zz` 是文件 → `zz/x.txt` 暂存得过、`mkdir` 时才炸）。还原失败那条更绕一层且在流水线里可达：
  `delete_file d` + `add_file d/x/y.txt` + `add_file zz/w.txt`——提交时删掉文件 `d`、`mkdir -p`
  把 `d` 变成目录、第三条炸；还原时 `d` 的位置已是目录，`rename` 报 EISDIR，于是两句话都留下。
  **还原是逆序的**（同一批里「先删文件 `d`、再在 `d/` 下建新文件」的还原必须先删 `d/x` 再写回 `d`），
  还原自身失败**不遇错即停**、逐条收集后汇总成 `"{原始错误}; failed to rollback partially applied
  patch: {逐条}"`（病因在前、磁盘现状在后）；全部还原成功时错误里不出现后半句。
  **executable 先写后置**：`atomicWrite` 会把**原文件**权限回填到临时文件再 rename，先置执行位
  会被那次回填整个盖掉。置位规则 `mode | ((mode & 0o444) >> 2)`（0644→0755、0600→**0700** 不是
  0711），清位无条件 `& ~0o111`，Windows 上整个函数 no-op。
  变更日志 `prepareChangeSet` 在 `commitChanges` **之前**；落盘失败 → `discardPreparedChange`
  不留孤儿账；成功 → `markChangeApplied`，而**它失败不让整条命令失败**（文件已改完，报错会让
  调用方以为没发生），照搬 Rust 的 `log::warn!` + 继续。
  **子 agent 在与 W7 对照时发现并修了自己的一个真 bug**（主会话已复核实现与回归测试）：
  `splitLines` 原来无条件剥末尾 `\r`，而 Rust 的 `str::lines()` 是先 `strip_suffix('\n')`、失败就
  整段原样返回——**末行没有换行符时它结尾的 `\r` 属于内容**（`"a\r"` 是一行 `"a\r"`）。
  无条件剥的后果是「以 `a\r` 结尾（无换行）」与「以 `a` 结尾」被判成同一份内容，
  **一次真实改动从 diff 里消失**。
  **一处判断不照搬**：`changes[]` 与日志入参里查不到暂存状态时它**抛错**，Rust 是 `filter_map`
  静默跳过——那种状态构造上不可能，但真发生时静默跳过意味着「文件照样被落盘、却不进
  `changedFiles` 也不进变更日志」= 一次撤不回来的改动且不报错。已在 `pipeline.ts` 注释点名。

### W14 · change journal：类型与写入

- **依赖**：N2
- **改动面**：`packages/host-node/src/workspace/change/types*`、`prepare*`
- **判据**：对齐 `workspace_change_journal_types.rs` + `_prepare.rs`。journal 目录取
  Tauri 的 `app_data_dir()/workspace-changes` 同款路径，使套壳后与桌面版共用同一份日志。
  跑该目录 vitest
- **模型**：opus
- **状态**：DONE `be30709`。6 个测试文件 / 74 例，最大 221 行。
  journal 目录**逐层查证**而非照记忆写：tauri `path/desktop.rs:247` → `dirs::data_dir()` →
  `dirs-6.0.0/src/{mac,win,lin}.rs` → `dirs-sys` 的 `home_dir()`。三平台推导做成纯函数并
  **按目标平台选 `path.win32` / `path.posix`**——否则在 macOS 上测 Windows 分支会拼出正斜杠，
  测试钉住一个生产里不存在的形状。
  **三条为对拍钉死的约定**（各有测试）：可空字段一律 `T | null` 而非 `T?`（`JSON.stringify`
  会把 `undefined` 的键整个丢掉，Node 写的条目比 Tauri 写的少几个键且不报错）；对象字面量的
  书写顺序 = Rust 字段声明顺序（serde 按声明序、`JSON.stringify` 按插入序，对齐了才逐字节相同）；
  hash 走 UTF-8 字节。
  `createdAt` 用 `performance.timeOrigin + performance.now()` 而非 `Date.now()`：批量回滚按它排序
  （`_batch.rs:45` 写着「Journal creation order is authoritative」），毫秒精度会让同一毫秒内的
  两条账并列。
  **复用了 `atomicWrite`**（与 N7 不冲突：N7 不能复用是因为权限语义相反，日志这边没有那个冲突），
  并借此白拿三样，其中一样是**修 Rust 的欠账**——Rust 的 `write_entry` 是 `fs::write` + `rename`、
  没有 fsync，而这份文件是「这次改动可撤销」的唯一凭据，掉电后目录项指向空洞内容 = 那次改动
  永久撤不回来且不报错。所有可观测输出逐字相同。
  **⚠️ 留给 W15 判的跨宿主隐患**：`workspaceRoot` 存的是 canonicalize 后的绝对路径、回滚时逐字
  比对。Rust 的 `fs::canonicalize` 在 Windows 上给 verbatim 前缀（`\\?\C:\…`），Node 的
  `realpath` 给 `C:\…`——**套壳后同一个 workspace 会被判成 `workspace_mismatch`**。
  POSIX 上两者一致，所以本卡没动。

### W15 · change journal：批次与 revert

- **依赖**：W14
- **改动面**：`packages/host-node/src/workspace/change/batch*`、`revert*`、`pathOps*`
- **判据**：对齐 `_batch.rs` + `_revert.rs` + `_path_ops.rs`：`dryRun` 语义、批次内顺序、
  部分失败的报告形态。跑该目录 vitest
- **模型**：opus
- **状态**：DONE `8a9a36e`（registrar 接线 `0762d59`）。17 个源文件 + 9 份测试 / 62 例，
  change 域合计 160 例。全树最大的一张卡。
  **`dryRun` 是「预演」不是「只校验」**：跑完整的四类冲突检测，只在最后一步分岔；
  `restoredFiles` 与真跑**逐字相同**（有测试直接对比两次结果的该字段）。批量的 dryRun 还会跑完整
  的逆序模拟，所以「单条预演冲突、整批预演通过」这种情况能正确报出来。
  **批次顺序不信入参**：按 `createdAt` 升序稳定排序后逆序执行。测法值得记——**故意用错误的
  入参顺序** `['ord-2','ord-1']` 退同一文件的两次连续改动，断言最终内容是 `a-1`；顺序若跟着
  入参走会停在 `a-2`（先退老的写回 a-1，再退新的又写回 a-2）**且全程 `ok: true`**，
  正是「说成功了其实写坏了」的形态。
  **三种失败报告形状不同**：预检冲突（`conflicts` 非空、`error` 为 null，一条盘都不碰）／
  执行中途漂移（`error` 非空、`conflicts` 为空，且已做过的每一步按组倒序补回去）／
  批量中途失败（逐条 `reapplyChangeSet` 回去，两个字段都空）。失败条目**一律不 `updateStatus`**
  ——`writeEntry(status:'reverted')` 是执行的最后一步，任何失败都在它之前返回，状态停在 `applied`、
  整批还能重试。有测试断言失败后磁盘内容与 `entry.status` 双双回到「没退过」。
  **Windows canonicalize 前缀判定为 T 线的事**（理由写在 `revertChangeSet.ts` 文件头，不是默默忽略）：
  ① 单边归一化只修一半——Node 认了 Rust 写的账、Rust 仍不认 Node 写的账，症状从「全都撤不了」
  变成「有时撤得了」，更难查；② 病根在写入侧不在比较侧，正确修法是统一写进日志的形态；
  ③ 现状 Node 自洽、POSIX 两边一致，风险窗口只存在于「Rust 写、Node 读」的过渡期，而那个过渡期
  就是 T 线本身。
  **照搬并记录三条**：`readSnapshot` 在执行循环里失败**不补偿**（`_revert.rs:127` 的 `?`）——
  前几个文件已还原、条目状态未改、调用方收到异常而非回执，窗口极窄但是「回滚了一半」的真实路径；
  `created-N.payload` 成功回滚后永久留在日志目录、无回收路径（它是批量补偿的唯一依据）；
  `content: null` 的歧义（清单第 3 条）在 `snapshotIo.ts` 头写明这一层分辨不出「真的不存在」
  与「条目被截断」。
  Node 侧三处实现选择（可观测行为与 Rust 一致）：目录项排序走 `Buffer.compare` 的 UTF-8 字节序
  （Rust 排的是 `OsString`）；解码 `{ fatal: true, ignoreBOM: true }`（默认会剥 BOM，
  于是带 BOM 的文件 hash 与 Rust 对不上、回滚被误判成冲突）；`chmod` 传完整 `st_mode` 不做
  `& 0o777`（掩掉会静默丢失 setuid/sticky）。

### W16 · Rust↔TS 对拍 fixture：patch 与 change journal

- **依赖**：W13、W15
- **改动面**：新建 `packages/host-node/fixtures/`（共享 JSON）+ 两侧的 fixture 驱动测试
- **判据**：**已知一处两边不该对齐的差异**（N2 交回，主会话已在 `workspace_common.rs:143` 证实）：
  Rust 对每个读取块单独跑 `String::from_utf8_lossy`，多字节字符被块边界劈开时两半各自变成 `�`
  ——中文输出只要跨块就会坏字。Node 侧用 `StringDecoder` 把块尾不完整的序列留到下一块，
  对未被劈开的合法 UTF-8 两边逐字节相同，被劈开时 Node 给的是**正确**结果。
  **本卡撞上这条时该改的是 Rust 侧**，不是把 Node 改回去凑对拍。理由记在
  `packages/host-node/src/workspace/common/index.ts` 的文件头。
  **新范式卡，会被 W17 抄。** 从 Rust 的 `workspace_patch_*_tests.rs` 与
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

### S5 · shell 的 platform 该由宿主说了算，不是调用方探测

- **依赖**：S1
- **改动面**：`packages/agent-core/src/runtime/hostPlatform.ts` 与 `shellCommand.ts` 的调用链；
  `apps/server` 的握手；`apps/web/src/host/`
- **判据**：**来源：N3 交回时点名的阻断项，`run_shell_command` 在 server 宿主下会整个不可用。**
  `platform` 由 core 的 `detectHostPlatform()` 在**调用方**探测后随命令传下去，宿主收到后校验
  「与自己不符就拒绝执行」。Tauri 下前端与原生同机，这条恒成立；**浏览器 → Node server 这条路上
  不成立**——用户在 macOS、服务端在 Linux，会稳定拿到 `platform mismatch: requested \`macos\`,
  current \`linux\``，一条 shell 命令都跑不了。
  那条校验本身挡的是真问题（模型按 A 平台组命令、宿主按 B 平台执行），**不能简单删掉**。
  正解大概率是让 core 从宿主握手拿平台而不是本地探测——`/api/health` 或桥的一次初始化调用
  回报宿主平台，core 用它组命令，于是「组命令」和「执行命令」用的是同一个事实。
  本卡要给出设计并落地，判据是：server 宿主下 macOS 浏览器 + Linux 服务端能正常跑 shell 命令，
  且「模型按错平台组命令」仍被挡住。
- **模型**：opus
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
- **判据**：**另有一条 H4b 交回的待办必须在本卡收掉**：`modelTurnSystemItems.ts` 的
  `buildEnvironmentItem` 在宿主有本机能力时写死「宿主：Tauri 桌面端（可用本机文件、shell 与
  Git 工具）」。今天只有 Tauri 一种 server 宿主，这句逐字成立；server 宿主一落地，浏览器用户
  就会被告知自己在 Tauri 桌面端，而这段文本是喂给**模型**的——模型会按错误的宿主假设行事。
  改成按能力而非按宿主品牌措辞（`modelTurnPrefix.ts` 的调用处已留注释指向这里）。
  三宿主各自的 invoke / 持久化 / 观测 driver 选择收口到 `host/`；
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
- **判据**：**先读 W4 卡面最后一段**——run index 的分页 cursor 里嵌了一个 snapshot 指纹，
  Node 侧用 sha256 前 16 hex 而 Rust 用 SipHash13，两者不互认。当前两个宿主的会话数据不共享，
  所以跨宿主 cursor 不会出现；本卡把持久化收敛到一起之后**这个前提就没了**，要重新评估
  （失败形态是可恢复的「refresh history」，不是数据损坏，但值得有意识地决定而不是撞上）。
  `persistenceDrivers` 从二选一变三选一；server 宿主下会话落 SQLite 而非 IndexedDB。
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
- **改动面**：`README.md`、`README.zh-CN.md`、`docs/README.md`、`CLAUDE.md`、
  **`docs/config-directory-override.md`**（N7 交回时点名：它现在只讲「桌面版」，而那套语义
  ——默认路径、旧配置安全复制、`WEB_AGENT_CONFIG_DIR` 隔离与密钥边界——已在 Node 宿主上等价成立）
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
