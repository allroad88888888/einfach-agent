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
S  server HTTP 外壳             S1 → S2/S3 → S4
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

全树 66 卡（H 线在执行中由 6 张增至 12 张，五张都是验收时才浮出来的：H1b 三卡共享测试脚手架、
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
`scripts/check-boundaries.js` 的 `capabilityPackages` 数组。

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
- **判据**：**本线试金石**。注意 CLI 至今没有桥（H5 交回时点名）——这**不是回归**（Node 里没有
  `globalThis.isTauri`，`isTauriHost()` 在 H1 之前也一直是 false），而是本卡要补的那个缺口本身：
  在此之前 CLI 的文件 / shell 工具对模型一直不可见。
  `configureHostInvoke` 在 `registerStandardTools` 之后调用；
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
