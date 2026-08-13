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

### S11 · 委派接缝整形（S2a 发现的结构债）

- **依赖**：S9（门禁先带临时例外落地）；开工前向用户拍板（体量可能自成一树）
- **改动面**：`packages/subagents/src/delegationBatch.ts` 对 core 内部容器的 5 条深导入
  （childAgentLoop/childModelClient/delegationPolicy/runtimeState/concurrency）——
  方向二选一：batch 执行段下沉回 core，或 `DelegateAgentRuntimeState` 收成
  opaque handle + 窄方法组
- **判据**：S9 白名单门禁的临时例外清零；委派行为不回归（subagents 全量测试）
- **模型**：opus
- **状态**：TODO（待拍板）

### S6b · CLI 尾款：21 处深导入搬家根 barrel

- **依赖**：S9
- **改动面**：`apps/cli/src` 除 setup 类地雷外的 21 处白名单外深导入 → `@web-agent/core`
  根 barrel（S9 已确认全部有正式通路，纯符号搬家）；`scripts/check-boundaries.js` 豁免表
  砍掉 apps/cli 那条（58→约 37 处观察项）
- **判据**：`pnpm exec vitest run apps/cli scripts` 全绿；`pnpm cli --help` 冒烟；
  `node scripts/check-boundaries.js` 通过且观察项减少
- **模型**：sonnet
- **状态**：DONE 309e091（观察项 78→57，apps/cli 豁免整条清除）

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
