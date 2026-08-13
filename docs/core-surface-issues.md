# core 公开面收敛 Issue 树（G4 实施）

目标：按 [core 公开面盘点](core-public-surface-audit.md) 的方案把 `@web-agent/core` 的公开
承诺面从 68 条深导入收敛到 9 条白名单 subpath。本树执行两步走的**步骤 1**（barrel +
codemod + 门禁，保留 `./*` 通配、非 breaking）；步骤 2（S10 删通配）按盘点结论与首次
npm 发包同批，本树只立卡不执行。

拍板口径（2026-08-13）：白名单 9 条不并域；E4–E7 由 S7 逐条判断——已有等价公开 API 的
换正式通路，需发明新 API 的先补 barrel 并记债；S10 GATED 至发包。

执行警戒：工作树内有另一会话的项目 Skills 在途文件（`apps/web/src/settings/*`、
`ProjectSkillsPanel*`、`packages/agent-core/src/runtime/toolContext.ts`、
`state/rootAtoms.ts`、`state/rootStore.ts`、`skills/projectSkillPreferences*`），
每卡 prompt 点名不碰；S5 的 apps/web 改写与其重叠面最大，排最后并在派前重查 status。

## 树

```text
S1a ./tools barrel＋域包改写(上)   S1b 域包改写(下)
S2a ./subagents 契约甄别与 barrel   S2b 消费方改写   S2c 回归修复
S3a ./persistence+./observability barrel   S3b 四 driver 包改写
S4  ./skills+./planning barrel 与改写
S5a 根 barrel 契约   S5b apps/web 改写(上)   S5c apps/web 改写(下)
S6  apps/cli 改写
S7a E 类处置(E1–E4)   S7b E 类处置(E5–E8)
S8  仅测试深导入改道
S9  check-boundaries 白名单门禁   S11 委派接缝整形(待拍板)
S10 删通配与 exports 定稿（GATED：首次 npm 发包批次）
```

并行规则：S1/S3/S4/S6 无依赖可并行；S2 依赖 S1a（barrel 范式）；S7 依赖 S3a（persistence
正式通路做参照）；S5 依赖 S7 结论且派前重查另一会话状态；S8 依赖 S1–S6；S9 依赖 S1–S8
全落地；S10 GATED。

## 卡

### S1a · ./tools barrel 与工具域改写（上）

- **依赖**：—
- **改动面**：`packages/agent-core/src/tools/index.ts`（新建 barrel，收 TOOLS-SPEC 公开面：
  types/registry/toolCatalog/toolCallTiming 等，甄别以盘点 A/C 类清单为准）；
  `tools/shell`、`tools/fs`、`tools/interaction` 的 `@web-agent/core/tools/*` 与
  `runtime/toolContext` 类深导入改走 `@web-agent/core/tools`
- **判据**：三域 `pnpm exec vitest run tools/shell tools/fs tools/interaction` 全绿；
  改写后深导入计数下降（贴 grep 前后对比）
- **模型**：sonnet
- **状态**：DONE 8b6ce38

### S1b · 工具域改写（下）

- **依赖**：S1a
- **改动面**：`tools/planning`、`tools/skills`、`tools/agents`、`tools/mcp`、
  `tools/standard` 同款改写
- **判据**：`pnpm exec vitest run tools` 全绿；`pnpm build`
- **模型**：sonnet
- **状态**：DONE 597cde3

### S2a · ./subagents 契约甄别与 barrel

- **依赖**：S1a
- **改动面**：`packages/agent-core/src/subagents/index.ts`（新建）；15 条被外部引用的
  子路径逐条判"契约 or 内部"——内部的不进 barrel、由 S2b 让消费方改走契约等价物，
  判不动的如实记录
- **判据**：barrel 只含判定为契约的导出，每条注明消费方；`pnpm exec vitest run
  packages/agent-core/src/subagents` 全绿
- **模型**：opus
- **状态**：DONE ac8380c

### S2b · 委派消费方改写

- **依赖**：S2a
- **改动面**：`packages/subagents`、`tools/agents` 的深导入改走 `@web-agent/core/subagents`
- **判据**：`pnpm exec vitest run packages/subagents tools/agents` 全绿；`pnpm build`
- **模型**：opus
- **状态**：DONE 32ed5a5（剩余 5 条内部深导入待 S11 整形）

### S3a · ./persistence 与 ./observability barrel

- **依赖**：—
- **改动面**：`packages/agent-core/src/state/persistence/index.ts` 与
  `packages/agent-core/src/observability/index.ts`（新建，只收 contract/port，不收
  hydrate 等内部实现——以盘点 C/E 类划线）
- **判据**：barrel 导出清单与盘点一致；`pnpm exec vitest run packages/agent-core/src/state
  packages/agent-core/src/observability` 全绿
- **模型**：sonnet
- **状态**：DONE d8e7a6f

### S3b · 四 driver 包改写

- **依赖**：S3a
- **改动面**：`packages/persistence-{idb,sqlite}`、`packages/observability-{idb,sqlite}`
  的深导入改走两条新 barrel
- **判据**：`pnpm exec vitest run packages/persistence-idb packages/persistence-sqlite
  packages/observability-idb packages/observability-sqlite` 全绿；`pnpm build`
- **模型**：sonnet
- **状态**：DONE 26dd539（残留 state/core.type 深导入归 S5a）

### S4 · ./skills 与 ./planning barrel 及改写

- **依赖**：—
- **改动面**：`packages/agent-core/src/skills/index.ts`、`planning/index.ts`（新建；
  **不导出**另一会话在途的 `projectSkillPreferences*`）；`tools/skills`、`tools/planning`
  改写
- **判据**：`pnpm exec vitest run tools/skills tools/planning` 全绿
- **模型**：sonnet
- **状态**：DONE 0a55ed7

### S5a · 根 barrel 契约

- **依赖**：S7a、S7b
- **改动面**：`packages/agent-core/src/index.ts`（新建：宿主装配 API——commands、
  coreInstance、persistenceBridge、observability 配置、atoms 只读面；atoms 边界按
  "UI 只读 atom"红线甄别）
- **判据**：barrel 清单与盘点 A 类对齐；build
- **模型**：opus
- **状态**：DONE b7c8b48（workspaceDialog 留深路径待 S9 定夺）

### S5b · apps/web 改写（上：非 settings 区）

- **依赖**：S5a；派前重查另一会话 status
- **改动面**：`apps/web/src` 中不与另一会话重叠的深导入改写
- **判据**：相关组件测试全绿；`pnpm build`
- **模型**：opus
- **状态**：DONE 77ae6b7（与 S5c 合并；深导入 211→21，残留分类见卡报告）

### S5c · apps/web 改写（下：settings 区，等另一会话落地）

- **依赖**：S5b、另一会话项目 Skills 工作落库
- **改动面**：`apps/web/src/settings/*` 等剩余深导入
- **判据**：`pnpm exec vitest run apps/web` 全绿；`pnpm build`
- **模型**：opus
- **状态**：DONE 77ae6b7（并入 S5b 执行）

### S6 · apps/cli 改写

- **依赖**：—
- **改动面**：`apps/cli/src` 的深导入改走白名单入口（barrel 未建齐的路径留待后补，
  只改已有 barrel 覆盖的）
- **判据**：`pnpm exec vitest run apps/cli` 全绿；`pnpm cli --help` 冒烟
- **模型**：sonnet
- **状态**：DONE 10725fe（27 条留 S5a/S7b；CLI 对 plugins/* 的深导入需 S5a 一并收口）

### S7a · E 类泄漏处置（E1–E4）

- **依赖**：S3a
- **改动面**：盘点 E 类前四条（compactionPlugin→ContextStats、finishReasonPlugin→
  delegationDistillation、traceCacheTotals、persistence 内部实现第一批）——有等价公开
  API 的换正式通路，没有的补最小公开导出并在盘点文档记债
- **判据**：对应消费方测试全绿；处置方式逐条记录
- **模型**：opus
- **状态**：DONE 8704399（E1/E2/E4 消除，E3 进 barrel 记债）

### S2c · S2b 回归修复（barrel 静态导链拉爆 vi.mock）

- **依赖**：S2b
- **改动面**：二分定罪 `32ed5a5`：`tools/agents`/`packages/subagents` 改走 subagents barrel
  后，静态导链把重模块拉进 vi.mock 生效前的模块图，`workspaceRead.*` 5 例与
  `SubagentTreePanel(.History)` 5 例挂掉。修复方向：追出 barrel 到 @tauri-apps 的具体链路，
  斩断重边（type-only / 端口延迟绑定）或让 tools/agents 回到窄深导入并在 S9 留例外
- **判据**：10 例全部转绿（含在干净 worktree 复验）；S2b 已改文件不回退大方向；
  `pnpm exec vitest run packages/agent-core/src/runtime/workspaceRead apps/web/src/agentNew/ui/SubagentTreePanel packages/subagents tools/agents` 全绿
- **模型**：opus
- **状态**：DONE 3911c9d

### S7b · E 类泄漏处置（E5–E8）

- **依赖**：S7a
- **改动面**：E 类后四条（含 `getSessionStore` 的 UI 红线违规——此条必须换正式只读通路，
  不允许补 barrel 了事）
- **判据**：同上；`getSessionStore` 不再被 UI import
- **模型**：opus
- **状态**：DONE a7c0223（E 类清零：消 3 / 进 barrel 1 / 记债 S11 1）

### S8 · 仅测试深导入改道

- **依赖**：S1–S6
- **改动面**：D 类 5 条的跨包测试改走白名单入口或搬回 core 包内
- **判据**：相关测试全绿；D 类清单归零
- **模型**：sonnet
- **状态**：DONE 70c6eb7（D 类 6 消 5，schemaValidate 留档待 S9 口径）

### S9 · check-boundaries 白名单门禁

- **依赖**：S1–S8
- **改动面**：`scripts/check-boundaries.js` + `.test.js`：core 之外的包 import
  `@web-agent/core/<白名单外路径>` 即 fail
- **判据**：当前仓库通过；测试覆盖命中与放行；`node scripts/check-boundaries.js`
- **模型**：opus（例外档案判断量升级）
- **状态**：DONE 4eee1e7（7 条规则 / 58 处观察项 11 条豁免；跨行 import 门禁漏洞一并修复）

### S11 · 委派接缝整形（侦察完成，方向 A：batch 下沉回 core）

- **侦察结论**：B（opaque handle）被否——公开面反而 +16 条且是内核结构换名，三处倒置
  （事件词汇分裂 / core 测试反向依赖 / Map 读写分居两包）一条不修；A 恢复"委派执行整块
  归一层"（Rust 侧实地核对的可迁移教训）。执行拆为 S11a–S11g。
- **状态**：DONE（a–g 全落，见各子卡；packages/subagents 对 core 深导入归零，三处倒置修复）

### S11a · firstAssistantText 归位 @web-agent/ai

- **依赖**：—
- **改动面**：`packages/agent-ai/src/modelContent.ts` 增访问器并导出；core 的
  `subagents/{childModelClient,childAgentLoop,childFinishReason}` 与
  `packages/subagents/src/{runtime,delegationDistillation}.ts` 改指 `@web-agent/ai`
- **判据**：`pnpm exec vitest run packages/agent-ai packages/agent-core/src/subagents packages/subagents` 全绿；childModelClient 不再导出该函数
- **模型**：sonnet
- **状态**：DONE 1713f46

### S11b · 委派端口补三条

- **依赖**：—
- **改动面**：`delegationRuntimePorts.ts`：`DelegationArchiveFormatPort` 增
  `cacheBasePath`/`eventsPath`；新增 `SubagentSkillDistillPort`（含 `SkillDistillChatInput`）
  与 `lowCostExtractionSettings` 端口成员；barrel 补类型；`packages/subagents/src/runtime.ts`
  按新形状注入（指向既有实现）。只加端口不搬逻辑
- **判据**：build + 相关 vitest；新端口签名不出现内核可变容器类型（逐条核对）
- **模型**：opus
- **状态**：DONE f1cee0a

### S11c · 蒸馏 chat 包装下沉 core

- **依赖**：S11a、S11b
- **改动面**：`delegationDistillation.ts`（42 行）搬为 core 的 `subagents/skillDistillChat.ts`，
  深导入变相对导入；删原文件
- **判据**：相关 vitest 全绿；`runtime/finishReason` 观察项消失
- **模型**：sonnet
- **状态**：DONE 2b60ae8

### S11d · batch 执行段下沉 core（主刀）

- **依赖**：S11c
- **改动面**：`delegationBatch.ts`（260 行）搬进 core，4 条深导入变相对导入，
  3 处产品调用换 S11b 端口；删原文件
- **判据**：8 份 `runtime.*.test.ts` + `archiveCapacity.test.ts` 全绿；新文件 ≤300；
  `packages/subagents` 对 childAgentLoop/delegationPolicy/concurrencyLimiter 的深导入归零
- **模型**：opus
- **状态**：DONE 665867a（观察项 55→50）

### S11e · runtime 工厂下沉与 barrel 收口

- **依赖**：S11d
- **改动面**：core 新建 `subagents/delegationRuntime.ts`（`createDelegationRuntime`，含
  生命周期四件套与 `runLowCostExtraction` 经端口取厂商档设置）；`packages/subagents/src/runtime.ts`
  退化为端口装配，**保留既有工厂名与签名**；barrel 补导出
- **判据**：`runtime.modelCompat.test.ts` 三例全绿；
  `grep -r '@web-agent/core/subagents/' packages/subagents/src` 归零；build
- **模型**：opus
- **状态**：DONE 083d609（packages/subagents 深导入归零，观察项 51→48）

### S11f · 门禁豁免清零与模块图复核

- **依赖**：S11e
- **改动面**：豁免表删 `packages/subagents` 整条；barrel 头注与两份盘点/树文档同步
- **判据**：门禁通过且观察项 -6；**全量 pnpm test + build**，重点复验 workspaceRead
  四处 vi.mock 与 SubagentTreePanel（barrel 值闭包 14→≈60 的 S2c 同款风险复验点）
- **模型**：opus
- **状态**：DONE 45b71e8（零消费导出删 5 条，S2c 风险终验全绿）

### S11g ·（可选）core 侧测试归位

- **依赖**：S11f
- **改动面**：`runtime.testHarness.ts` 等 11 份 core 测试改用 core 自己的工厂 + 假端口，
  斩断 core 测试 → `@web-agent/subagents` 反向依赖；真测装配的逐条说明保留
- **判据**：`grep -r '@web-agent/subagents' packages/agent-core/src` 只剩带说明的装配测试
- **模型**：opus
- **状态**：DONE 1ee6553（13 归位 / 2 保留注明，113 例守恒）

### S10 · 删通配与 exports 定稿（GATED）

- **依赖**：S9 + **首次 npm 发包批次**（盘点结论：与发包同批，否则 `./*` 随 0.1.0 发出后
  再删就是 breaking）
- **改动面**：core `package.json` exports 收窄为 9 条、vite alias/tsconfig paths 收窄、
  `dist/` 的 Node 原生解析冒烟（白名单外路径须抛错）
- **判据**：见盘点第 6 节；冒烟脚本进 CI
- **模型**：opus
- **状态**：GATED（发包批次前不开工）

## T · 超限文件拆分（执行中反复标记的存量债，与 S 线并行）

### T1 · 拆 modelRun.test.ts（4145 行）

- **依赖**：—
- **改动面**：`packages/agent-core/src/runtime/modelRun.test.ts` 按职责拆为多份
  （请求投影 / 工具循环 / 暂停确认 / checkpoint 持久化 / 模型身份设置等），公共夹具抽
  harness 文件；每份 ≤500 行
- **判据**：拆分前后用例总数一致（贴数字）；`pnpm exec vitest run packages/agent-core/src/runtime/modelRun*` 全绿
- **模型**：sonnet
- **状态**：DONE 881779e

### T2 · 拆 subagents/runtime.test.ts（2694 行）

- **依赖**：—
- **改动面**：`packages/agent-core/src/subagents/runtime.test.ts` 按职责拆
  （预算并发 / 归档观测 / 蒸馏 / 身份透传等），公共夹具抽 harness；每份 ≤500 行
- **判据**：用例总数一致；`pnpm exec vitest run packages/agent-core/src/subagents` 全绿
- **模型**：sonnet
- **状态**：DONE 4609511

### T3 · 拆 runtime/commands.test.ts（1488 行）

- **依赖**：—
- **改动面**：`packages/agent-core/src/runtime/commands.test.ts` 按职责拆
  （session/run 生命周期 / 暂停恢复 / config 与实例隔离）；每份 ≤500 行
- **判据**：用例总数一致；`pnpm exec vitest run packages/agent-core/src/runtime/commands` 全绿
- **模型**：sonnet
- **状态**：DONE aa4b1a4

### T4 · 拆 compactionPlugin.test.ts（584 行）与 hydrate.test.ts（448 行）

- **依赖**：—
- **改动面**：两份测试各按既有报告的建议切面拆（compaction 按行为面；hydrate 把
  "模型兼容迁移"拆出 `hydrate.modelMigration.test.ts`）；每份 ≤500 行
- **判据**：用例总数一致；`pnpm exec vitest run packages/agent-core/src/runtime/core/plugins packages/agent-core/src/state/persistence` 全绿
- **模型**：sonnet
- **状态**：DONE 9c6e509

### T5 · 拆 persistence-sqlite/sqliteDriver.ts（452 行）

- **依赖**：—
- **改动面**：`packages/persistence-sqlite/src/sqliteDriver.ts` 按职责拆（sessions 持久化 /
  history driver / 共享底座各归各文件），公开导出经 `index.ts` 不变
- **判据**：`pnpm exec vitest run packages/persistence-sqlite` 全绿；各文件 ≤300
- **模型**：sonnet
- **状态**：DONE 5ae05a7

### T6 · 拆 subagents/archive/replay.ts（445 行）

- **依赖**：—
- **改动面**：`packages/subagents/src/archive/replay.ts` 按阶段拆（事件解析 / 树重建 /
  报告投影），公开导出不变
- **判据**：`pnpm exec vitest run packages/subagents/src/archive scripts/subagent-replay-lib.test.js` 全绿；各文件 ≤300
- **模型**：sonnet
- **状态**：DONE 1197893

### T7 · 拆 agentnew.css（4213 行，聚合器模式）

- **依赖**：—
- **改动面**：`apps/web/src/agentNew/ui/agentnew.css` 按面板域拆成多份
  `agentnew.<域>.css`，原文件退化为纯 `@import` 聚合器——**不动任何 TS/TSX**
  （S5b 并行在改 apps/web 的 TS）
- **判据**：拆分后聚合器 + 各分片行数合计与原文件一致（允许 ±import 行）；
  `pnpm exec vitest run apps/web/src/agentNew/ui/PluginSettingsPanel.test.tsx` 冒烟；
  各分片 ≤500
- **模型**：sonnet
- **状态**：DONE 50de5b1（视觉级联请用户 pnpm dev 肉眼复核一次）

### T8 · 拆 apps/desktop/src/mcp.rs（2202 行）

- **依赖**：—
- **改动面**：`apps/desktop/src/mcp.rs` 按职责拆为子模块（连接管理 / stdio 进程 /
  协议编解码 / Tauri command 面等，以实际结构为准），`mod` 组织、公开面不变
- **判据**：`cargo test --manifest-path apps/desktop/Cargo.toml` 全绿；各文件 ≤500
- **模型**：opus
- **状态**：DONE c0e872e

### T9 · 拆 runtime/modelTurn.ts（684 行）

- **依赖**：—
- **改动面**：core 的 `runtime/modelTurn.ts` 按职责拆（先读结构再定切面），公开导出不变
- **判据**：`pnpm exec vitest run packages/agent-core/src/runtime` 全绿 + build + 波及面口径；各文件 ≤500
- **模型**：opus
- **状态**：DONE 6c726c0

### T10 · 拆 runtime/toolContext.ts（604 行）

- **依赖**：—
- **改动面**：core 的 `runtime/toolContext.ts` 按职责拆（ToolContext 构建是安全边界，只搬不改）；
  注意该文件刚被 1908f87（workspace skill controls）改过，基线以 HEAD 为准
- **判据**：`pnpm exec vitest run packages/agent-core/src/runtime tools` 全绿 + build；各文件 ≤500
- **模型**：opus
- **状态**：DONE b93c27f

### T11 · 拆 workspace_write.rs（2178 行）

- **依赖**：—
- **改动面**：`apps/desktop/src/workspace_write.rs` 按 T8 的 `#[path]` 子模块先例拆
- **判据**：`cargo test --manifest-path apps/desktop/Cargo.toml` 全绿；各文件 ≤500
- **模型**：opus
- **状态**：DONE fea37d5

### T12 · 拆 workspace_read.rs（1843 行）

- **依赖**：—
- **改动面**：`apps/desktop/src/workspace_read.rs` 同款拆分
- **判据**：cargo test 全绿；各文件 ≤500
- **模型**：opus
- **状态**：DONE 8c208ed

### T13 · 拆 workspace_change_journal.rs（1366）与 workspace_patch.rs（1258）

- **依赖**：T11、T12（同域文件，避免 mod 声明冲突）
- **改动面**：两文件同款拆分
- **判据**：cargo test 全绿；各文件 ≤500
- **模型**：opus
- **状态**：DONE f62868e

### T14 · 拆 workspace_git.rs（786）与 shell.rs（716）

- **依赖**：T13
- **改动面**：两文件同款拆分
- **判据**：cargo test 全绿；各文件 ≤500
- **模型**：sonnet
- **状态**：DONE bfe7703（全仓生产源码硬上限违规归零）
