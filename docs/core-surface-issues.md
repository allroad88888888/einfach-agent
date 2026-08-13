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
S2a ./subagents 契约甄别与 barrel   S2b 消费方改写
S3a ./persistence+./observability barrel   S3b 四 driver 包改写
S4  ./skills+./planning barrel 与改写
S5a 根 barrel 契约   S5b apps/web 改写(上)   S5c apps/web 改写(下)
S6  apps/cli 改写
S7a E 类处置(E1–E4)   S7b E 类处置(E5–E8)
S8  仅测试深导入改道
S9  check-boundaries 白名单门禁
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
- **状态**：TODO

### S1b · 工具域改写（下）

- **依赖**：S1a
- **改动面**：`tools/planning`、`tools/skills`、`tools/agents`、`tools/mcp`、
  `tools/standard` 同款改写
- **判据**：`pnpm exec vitest run tools` 全绿；`pnpm build`
- **模型**：sonnet
- **状态**：TODO

### S2a · ./subagents 契约甄别与 barrel

- **依赖**：S1a
- **改动面**：`packages/agent-core/src/subagents/index.ts`（新建）；15 条被外部引用的
  子路径逐条判"契约 or 内部"——内部的不进 barrel、由 S2b 让消费方改走契约等价物，
  判不动的如实记录
- **判据**：barrel 只含判定为契约的导出，每条注明消费方；`pnpm exec vitest run
  packages/agent-core/src/subagents` 全绿
- **模型**：opus
- **状态**：TODO

### S2b · 委派消费方改写

- **依赖**：S2a
- **改动面**：`packages/subagents`、`tools/agents` 的深导入改走 `@web-agent/core/subagents`
- **判据**：`pnpm exec vitest run packages/subagents tools/agents` 全绿；`pnpm build`
- **模型**：opus
- **状态**：TODO

### S3a · ./persistence 与 ./observability barrel

- **依赖**：—
- **改动面**：`packages/agent-core/src/state/persistence/index.ts` 与
  `packages/agent-core/src/observability/index.ts`（新建，只收 contract/port，不收
  hydrate 等内部实现——以盘点 C/E 类划线）
- **判据**：barrel 导出清单与盘点一致；`pnpm exec vitest run packages/agent-core/src/state
  packages/agent-core/src/observability` 全绿
- **模型**：sonnet
- **状态**：TODO

### S3b · 四 driver 包改写

- **依赖**：S3a
- **改动面**：`packages/persistence-{idb,sqlite}`、`packages/observability-{idb,sqlite}`
  的深导入改走两条新 barrel
- **判据**：`pnpm exec vitest run packages/persistence-idb packages/persistence-sqlite
  packages/observability-idb packages/observability-sqlite` 全绿；`pnpm build`
- **模型**：sonnet
- **状态**：TODO

### S4 · ./skills 与 ./planning barrel 及改写

- **依赖**：—
- **改动面**：`packages/agent-core/src/skills/index.ts`、`planning/index.ts`（新建；
  **不导出**另一会话在途的 `projectSkillPreferences*`）；`tools/skills`、`tools/planning`
  改写
- **判据**：`pnpm exec vitest run tools/skills tools/planning` 全绿
- **模型**：sonnet
- **状态**：TODO

### S5a · 根 barrel 契约

- **依赖**：S7a、S7b
- **改动面**：`packages/agent-core/src/index.ts`（新建：宿主装配 API——commands、
  coreInstance、persistenceBridge、observability 配置、atoms 只读面；atoms 边界按
  "UI 只读 atom"红线甄别）
- **判据**：barrel 清单与盘点 A 类对齐；build
- **模型**：opus
- **状态**：TODO

### S5b · apps/web 改写（上：非 settings 区）

- **依赖**：S5a；派前重查另一会话 status
- **改动面**：`apps/web/src` 中不与另一会话重叠的深导入改写
- **判据**：相关组件测试全绿；`pnpm build`
- **模型**：opus
- **状态**：TODO

### S5c · apps/web 改写（下：settings 区，等另一会话落地）

- **依赖**：S5b、另一会话项目 Skills 工作落库
- **改动面**：`apps/web/src/settings/*` 等剩余深导入
- **判据**：`pnpm exec vitest run apps/web` 全绿；`pnpm build`
- **模型**：opus
- **状态**：TODO

### S6 · apps/cli 改写

- **依赖**：—
- **改动面**：`apps/cli/src` 的深导入改走白名单入口（barrel 未建齐的路径留待后补，
  只改已有 barrel 覆盖的）
- **判据**：`pnpm exec vitest run apps/cli` 全绿；`pnpm cli --help` 冒烟
- **模型**：sonnet
- **状态**：TODO

### S7a · E 类泄漏处置（E1–E4）

- **依赖**：S3a
- **改动面**：盘点 E 类前四条（compactionPlugin→ContextStats、finishReasonPlugin→
  delegationDistillation、traceCacheTotals、persistence 内部实现第一批）——有等价公开
  API 的换正式通路，没有的补最小公开导出并在盘点文档记债
- **判据**：对应消费方测试全绿；处置方式逐条记录
- **模型**：opus
- **状态**：TODO

### S7b · E 类泄漏处置（E5–E8）

- **依赖**：S7a
- **改动面**：E 类后四条（含 `getSessionStore` 的 UI 红线违规——此条必须换正式只读通路，
  不允许补 barrel 了事）
- **判据**：同上；`getSessionStore` 不再被 UI import
- **模型**：opus
- **状态**：TODO

### S8 · 仅测试深导入改道

- **依赖**：S1–S6
- **改动面**：D 类 5 条的跨包测试改走白名单入口或搬回 core 包内
- **判据**：相关测试全绿；D 类清单归零
- **模型**：sonnet
- **状态**：TODO

### S9 · check-boundaries 白名单门禁

- **依赖**：S1–S8
- **改动面**：`scripts/check-boundaries.js` + `.test.js`：core 之外的包 import
  `@web-agent/core/<白名单外路径>` 即 fail
- **判据**：当前仓库通过；测试覆盖命中与放行；`node scripts/check-boundaries.js`
- **模型**：sonnet
- **状态**：TODO

### S10 · 删通配与 exports 定稿（GATED）

- **依赖**：S9 + **首次 npm 发包批次**（盘点结论：与发包同批，否则 `./*` 随 0.1.0 发出后
  再删就是 breaking）
- **改动面**：core `package.json` exports 收窄为 9 条、vite alias/tsconfig paths 收窄、
  `dist/` 的 Node 原生解析冒烟（白名单外路径须抛错）
- **判据**：见盘点第 6 节；冒烟脚本进 CI
- **模型**：opus
- **状态**：GATED（发包批次前不开工）
