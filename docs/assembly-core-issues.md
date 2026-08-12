# 装配式内核 Issue 树

目标：`agent-core` 向「内核只认识工具和钩子」的装配式形态收敛——触发器工具化、实现包化、
机制留核。能力（skills、planning、子 Agent、存储、观测）从内核子系统改为装配期安装的能力包，
应用可任意组装、替换实现。

前提事实（写卡时已核实）：

- 插件面已存在：`runtime/core/pluginApi.ts` 支持 `hook()`（七个 loop 槽）与 `registerTool()`，
  见 [Core 插件化蓝图](core-plugin-extraction-blueprint.md)。能力包优先骑现有面，不新造框架。
- 模型可见面已是工具形状：`tools/{skills,planning,agents}` 三个工具域包已独立。
  本树只做反转的另一半：把工具背后的实现从 core 搬给能力包，core 留槽（`createCore` 显式配置
  槽，不做通用服务注册表——「没有第二个读者的 port 不开」）。
- 不动的红线：子 run 机制（child 循环与硬限）留核，Rust 参考实现同样如此；
  `runtime/workspace*.ts` 等宿主桥外移是另一棵树的事（见未决）。
- 状态中枢化（A1 裁决）：装配式 ≠ 状态私有化。进 checkpoint 的持久状态集中定义在 core 的
  `state/`（对齐 Rust 侧中央账本），能力包迁走的是逻辑、工具与 driver；第三方持久状态待
  R5 批准后走 `pluginTimelineItems`。
- 已决策（2026-08-12）：引入工具 **CallTiming** 维度（A2–A5），对齐并超集 Rust 侧设计——
  生命周期动作统一进工具抽象：`callTiming` 非空的工具不进模型可见清单，由 loop 到点执行并
  作为一等 timeline item 记账。时机全集九档：`sessionStart` / `runStart` / `runEnd` /
  `turnStart` / `turnEnd` / `preCompact` / `postCompact` / `subagentStart` / `subagentEnd`
  （`sessionEnd` 不设，理由见未决）。第一个读者是 skills 开局清单注入（B3）；
  plugin hook 面继续保留，两者分工写进 `TOOLS-SPEC.md`。

## 模型指派

执行器为 codex CLI，按风险两档：

| 风险 | 模型字段写法 | 含义 |
| --- | --- | --- |
| 高（契约、状态机、会被后续抄的范式） | `codex xhigh` | `gpt-5.6-terra` + `model_reasoning_effort=xhigh` |
| 低（机械搬移、纯删除、接线） | `codex medium` | `gpt-5.6-terra` + `model_reasoning_effort=medium` |

派活形态（后台/非交互跑必须 `< /dev/null`，防 stdin 挂起）：

```bash
codex exec --model gpt-5.6-terra -c model_reasoning_effort=<档位> "<卡全文+判据+边界规则>" < /dev/null
```

## 执行约定

- 一个 issue = 一次 commit，conventional commit 单行主题；只 stage 该 issue 的文件。
- 主会话派活并亲自验证判据，不采信子 agent 自述。
- 并行规则：B / C / D 三分支依赖满足后可并行，但 D1/D2 共同触碰
  `vite.config.ts`、`tsconfig.app.json`、`apps/web/src/main.tsx`，分支内一律串行；
  E 分支整体最后串行。
- 新增包必须同步 `vite.config.ts` 的 `resolve.alias` 与 `tsconfig.app.json` 的 `paths`。

## 树

```text
A 地基          A1 checkpoint 状态切片 port（撤销，见卡内裁决）；A2 CallTiming 契约 → A3 主干五点位与分派 API → A4 压缩点位、A5 子 Agent 点位
B skills 试点   B1 core 开槽 → B2 实现迁包 → B3 清单注入迁 sessionStart timed 工具（依赖 A3）
C planning      C1 core 开槽 → C2 实现迁包（plan 状态与 planWriters 留核）
D 存储与观测    D1 idb 持久化外移 → D2 sqlite 持久化外移；D3 观测发射收敛 → D4 观测 driver 外移 → D5 TraceViewer 出核
E 子 Agent      E0 摸底 → E1 delegation 槽 → E2 调度编排迁包 → E3 归档治理迁包、E4 视图 atoms 迁移
F 收尾          F1 边界执法脚本 → F2 文档同步
```

## A · 地基

### A1 · core 提供能力包状态切片的 checkpoint 参与 port（已撤销）

- **依赖**：—
- **裁决（2026-08-12）**：执行时确认与
  [自定义持久化 Timeline Item RFC](persistent-plugin-timeline-item-rfc.md) 结构性冲突：
  RFC 在 owner 批准前禁止开放插件持久化写入 API，且唯一规划的 checkpoint 扩展是带
  schema/配额/decoder/quarantine 约束的 `pluginTimelineItems`——通用 snapshot/restore
  切片 port 恰是 RFC 要防的「第二套持久化参与机制」。裁决改走**状态中枢化**路线
  （对齐 Rust 侧中央账本）：第一方能力包的持久状态定义留在 core 的 `state/`，能力包
  只迁逻辑、工具与 driver；第三方持久状态待 R5 批准后走 `pluginTimelineItems`。
  C1/C2 改动面已按此调整，不再依赖本卡。
- **模型**：—
- **状态**：撤销

### A2 · Tool 契约增加 callTiming 维度并从模型可见清单剔除

- **依赖**：—
- **改动面**：`packages/agent-core/src/tools/types.ts`（`callTiming?: 'sessionStart' | 'runStart' |
  'runEnd' | 'turnStart' | 'turnEnd' | 'preCompact' | 'postCompact' | 'subagentStart' |
  'subagentEnd' | \`${string}:${string}\``——核心九档字面量 + `<domain>:<event>` 形式的扩展
  时机，扩展时机由持有分派 API 的装配层触发，MCP 生命周期是第一个预期使用方）、
  `packages/agent-core/src/tools/toolRegistry.ts`、`packages/agent-core/src/tools/toolCatalog.ts`、
  `packages/agent-core/src/tools/registry.ts`、`packages/agent-core/src/tools/TOOLS-SPEC.md`
  及 colocated 测试
- **判据**：`callTiming` 非空的工具不出现在 `list()` 清单、目录搜索与
  `request_tool_schema` 可达面；**剔除与分派逻辑一律按「非空即剔除 / 按值取执行点」判定，
  禁止穷举 switch**——增补时机不得触碰剔除面；危险约束**不在注册期做**（验收时更正：
  Tool 契约没有危险标记，风险由运行时按调用上下文评估——注册期布尔字段会成为第二份真相），
  改由 A3 分派器执行前咨询既有风险评估；注册期校验：**来源为 MCP 清单或其他外部声明的
  工具禁止携带 `callTiming`**，注册期剥除并记诊断——自动执行面不得被外部来源占用
  （本地注册的工具挂 `mcp:` 域扩展时机不受此限）；
  `pnpm exec vitest run packages/agent-core/src/tools`；`pnpm build`
- **模型**：codex xhigh
- **状态**：DONE（哈希在下一次提交补记）

### A3 · loop 主干五点位到点执行、一等记账与公开分派 API

- **依赖**：A2
- **改动面**：`packages/agent-core/src/runtime/runToolLoop.ts`、
  `packages/agent-core/src/runtime/toolLoopBootstrap.ts`、
  `packages/agent-core/src/runtime/toolCallExecutor.ts`、
  `packages/agent-core/src/state/checkpointWriters.ts`、新增 `runtime/timedDispatch.ts`
  （分派辅助，≤300 行）及 colocated 测试；与 D3 潜在重叠（runtime 循环文件），执行时错峰
- **判据**：覆盖主干五点位 `sessionStart` / `runStart` / `runEnd` / `turnStart` / `turnEnd`；
  到点调用复用既有工具执行路径（同一 `ToolContext`、同一审计面），结果落为可持久化
  timeline item 并进 checkpoint；`sessionStart` 每会话恰好一次、恢复的会话以既有 timed item
  为准不重复执行；`runStart`/`runEnd` 每 run 一次、`turnStart`/`turnEnd` 每模型轮一次；
  timed 工具失败降级为记录错误、不中断 run；同一时机多工具按注册序；某时机无注册工具时
  零开销、不产生 item；**到点分派不经过确认门，分派前必须咨询既有风险评估
  （dangerousTools / 确认门插件语义），非 safe 的到点调用拒绝执行并记诊断**；
  **分派入口经 `CoreInstance` 暴露为受限 API**（装配层据此触发
  `<domain>:<event>` 扩展时机，为 MCP 生命周期预留，本树不实现 MCP 侧接入）；
  `pnpm exec vitest run packages/agent-core/src/runtime`；`pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

### A4 · 压缩点位：preCompact / postCompact

- **依赖**：A3
- **改动面**：`packages/agent-core/src/runtime/core/plugins/compactionPlugin.ts`（压缩真实
  发生处分派）、`packages/agent-core/src/runtime/contextCompaction.ts` 衔接及 colocated 测试
- **判据**：仅在压缩真实发生时触发（无压缩的 run 零触发）；`preCompact` item 记账于压缩
  边界之前、`postCompact` 于其后，与压缩投影语义兼容（既有压缩测试不回退）；
  `pnpm exec vitest run packages/agent-core/src/runtime/core/plugins packages/agent-core/src/runtime`；
  `pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

### A5 · 子 Agent 点位：subagentStart / subagentEnd

- **依赖**：A3
- **改动面**：`packages/agent-core/src/subagents/childAgentLoop.ts`（bootstrap 与收尾处分派）、
  `packages/agent-core/src/subagents/childResult.ts` 衔接及 colocated 测试；
  与 E 分支同域，执行时排在 E2 之前并错峰
- **判据**：分派在子 run 的 `ToolContext` 里执行、item 落子 Agent timeline；子 Agent 失败/中止
  路径同样触发 `subagentEnd`；深度/子数/预算硬限对 timed 分派不放宽；
  `pnpm exec vitest run packages/agent-core/src/subagents`；`pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

## B · skills 试点（Rust 侧 M15 判例：skills = 索引 + 读取工具）

### B1 · CoreInstance 摘除内建 projectSkills 扫描，改为 createCore 配置槽注入

- **依赖**：—
- **改动面**：`packages/agent-core/src/runtime/core/coreInstance.ts`、
  `packages/agent-core/src/runtime/core/createCore.ts`、
  `packages/agent-core/src/runtime/projectSkillsBridge.ts`、
  `apps/web/src/main.tsx`、`apps/web/src/test/setup.ts`
- **判据**：`coreInstance.ts` 不再 import `skills/projectSkillsLoader`（grep 判定）；
  槽契约类型（`ProjectSkillsSnapshot` 一族）留在 core；项目 skills 行为不变：
  `pnpm exec vitest run packages/agent-core/src/runtime/core tools/skills`；`pnpm build`
- **模型**：codex xhigh
- **状态**：DOING

### B2 · skills 实现（loader、registry、内置 skill 内容）迁入 tools-skills

- **依赖**：B1
- **改动面**：`packages/agent-core/src/skills/` 下 `projectSkillsLoader.ts`、`registry.ts`、
  内置 skill `.md` 与 `planning/` 资源目录迁至 `tools/skills/src/`；契约类型文件
  `projectSkills.ts` 留核；装配点（`apps/web/src/main.tsx`、`apps/web/src/test/setup.ts`）
  改从 `@web-agent/tools-skills` 注入；`runtime/modelTurnPrefix.ts`、
  `runtime/transcriptInjection.ts`、`runtime/toolContext.ts` 改读槽而非直接 import
- **判据**：`grep -r "skills/projectSkillsLoader\|skills/registry" packages/agent-core/src`
  无非契约残留；稳定前缀不因注入点变化而失效（`modelTurnPrefix` 相关测试通过）；
  `pnpm exec vitest run tools/skills packages/agent-core`；`pnpm build`
- **模型**：codex medium
- **状态**：TODO

### B3 · skills L1 清单注入迁移为 sessionStart timed 工具

- **依赖**：B2、A3
- **改动面**：`tools/skills/src/`（注册 `callTiming: 'sessionStart'` 工具，产出 L1 清单
  timeline item）、`packages/agent-core/src/runtime/modelTurnPrefix.ts`（摘除清单组装段）、
  `packages/agent-core/src/runtime/transcriptInjection.ts`、
  `packages/agent-core/src/runtime/contextCacheFingerprint.ts` 相关测试
- **判据**：模型实际收到的清单内容与迁移前语义等价（断言覆盖）；新会话的前缀缓存命中不回退
  （`modelTurnPrefix` 与 `contextCacheFingerprint` 测试）；既有会话因请求形状变化发生一次性
  缓存失效属预期，不视为回归；`pnpm exec vitest run tools/skills packages/agent-core`；
  `pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

## C · planning 出核

### C1 · core 开 plan 能力槽，runtime 耦合点改经槽访问

- **依赖**：—
- **改动面**：`packages/agent-core/src/planning/runtime.ts`（收缩为契约 + 槽）、
  `packages/agent-core/src/planning/types.ts`（契约留核）、
  `packages/agent-core/src/runtime/toolContext.ts`、
  `packages/agent-core/src/runtime/commands/planCommands.ts` 及 colocated 测试
- **判据**：plan 状态 atoms 与 `state/planWriters.ts` **留核不动**（A1 裁决：状态中枢化）；
  toolContext 与 planCommands 对 plan 逻辑的调用改经 `createCore` 注入槽，未注入时 plan
  工具与命令明确报错不崩溃；`checkpoint 含 plan` 的既有测试不回退；
  `pnpm exec vitest run packages/agent-core/src/planning packages/agent-core/src/runtime`；
  `pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

### C2 · planning 逻辑实现迁入 tools-planning，删除 core 残留

- **依赖**：C1
- **改动面**：`packages/agent-core/src/planning/migrate.ts` 与 `planning/runtime.ts` 中非契约
  实现迁至 `tools/planning/src/`；`state/planWriters.ts` 与 plan 状态 atoms 留核；
  装配点接线（`apps/web/src/main.tsx`、`apps/web/src/test/setup.ts`）
- **判据**：`grep -r "from '.*planning/" packages/agent-core/src/runtime` 只剩契约 import；
  `pnpm exec vitest run tools/planning packages/agent-core`；`pnpm build`
- **模型**：codex medium
- **状态**：TODO

## D · 存储与观测外移

### D1 · IndexedDB 持久化 driver 外移为独立包

- **依赖**：—
- **改动面**：新包 `packages/persistence-idb`（自
  `packages/agent-core/src/state/persistence/indexedDbDriver.ts` 迁入，含测试）；
  `vite.config.ts`、`tsconfig.app.json`、`apps/web/src/main.tsx` 接线；
  core 内保留 `contract.ts` 与 `memoryHistoryDriver.ts`
- **判据**：`pnpm exec vitest run packages/persistence-idb packages/agent-core/src/state`；
  `pnpm build`；Web 会话持久化行为不变
- **模型**：codex medium
- **状态**：TODO

### D2 · SQLite 持久化 driver 外移为独立包（Tauri 依赖随走）

- **依赖**：D1
- **改动面**：新包 `packages/persistence-sqlite`（自
  `packages/agent-core/src/state/persistence/sqliteDriver.ts` 迁入，含测试）；
  `packages/agent-core/package.json` 移除 `@tauri-apps/plugin-sql`；
  `vite.config.ts`、`tsconfig.app.json`、`apps/web/src/main.tsx` 接线
- **判据**：`grep -rn "@tauri-apps/plugin-sql" packages/agent-core/src` 无结果；
  `pnpm exec vitest run packages/persistence-sqlite packages/agent-core/src/state`；`pnpm build`
- **模型**：codex medium
- **状态**：TODO

### D3 · 观测事件发射收敛为单一 port

- **依赖**：—
- **改动面**：`packages/agent-core/src/observability/` 新增 contract；
  `runtime/` 中直接 import `observability/` 的文件（执行时以
  `grep -rl "from '.*observability/" packages/agent-core/src/runtime` 现算为准，写卡时为 18 个）
  改经 `CoreInstance` 持有的 port 发射；`runtime/core/coreInstance.ts`
- **判据**：runtime 对 observability 的直接 import 收敛为仅 contract；
  trace 相关既有测试不回退：`pnpm exec vitest run packages/agent-core`；`pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

### D4 · 观测 driver 外移为宿主包

- **依赖**：D3
- **改动面**：新包 `packages/observability-idb`（`indexedDbLogDriver.ts`、
  `indexedDbLogReader.ts`）与 `packages/observability-sqlite`（`sqliteLogDriver.ts`、
  `sqliteLogReader.ts`、`devSqliteLogReader.ts`），均自
  `packages/agent-core/src/observability/` 迁入；`logReader.ts` 收缩为契约；
  `vite.config.ts`、`tsconfig.app.json`、`apps/web/src/main.tsx` 接线
- **判据**：core 的 observability 目录只剩 contract 与纯逻辑；
  `pnpm exec vitest run packages/observability-idb packages/observability-sqlite packages/agent-core`；
  `pnpm build`
- **模型**：codex medium
- **状态**：TODO

### D5 · TraceViewer 出核，core 摘除 react peerDependency

- **依赖**：D4
- **改动面**：`packages/agent-core/src/observability/TraceViewer.tsx`、
  `packages/agent-core/src/observability/traceViewerState.ts` 迁至 `apps/web/src/`；
  `packages/agent-core/package.json` 移除 `react` 与 `@einfach/react` peerDependencies
- **判据**：`grep -rn "from 'react'" packages/agent-core/src` 无结果；
  trace viewer 组件测试随迁通过；`pnpm exec vitest run apps/web packages/agent-core`；`pnpm build`
- **模型**：codex medium
- **状态**：TODO

## E · 子 Agent 机制/产品切割（最后执行）

### E0 · 摸底：subagents/ 29 文件逐个归类「机制留核 / 产品出核」

- **依赖**：—
- **改动面**：本文件 E 分支卡片（E1–E4 改动面更新到文件级定稿）
- **判据**：每个 `packages/agent-core/src/subagents/` 文件出现在且仅出现在一张卡的改动面里，
  归类附一句理由；`node scripts/check-docs.js`
- **模型**：codex xhigh
- **状态**：DOING

### E1 · core 定义 delegation 执行器槽（ToolContext 委派能力经装配注入）

- **依赖**：E0
- **改动面**：`packages/agent-core/src/runtime/core/coreInstance.ts`、
  `packages/agent-core/src/runtime/core/createCore.ts`、
  `packages/agent-core/src/runtime/toolContext.ts`、
  `packages/agent-core/src/tools/TOOLS-SPEC.md` 同步；未注入时 delegate 族工具不可用且有明确报错
- **判据**：`pnpm exec vitest run packages/agent-core/src/runtime tools/agents`；`pnpm build`；
  只做注入不做多实现承诺（见未决）
- **模型**：codex xhigh
- **状态**：TODO

### E2 · 调度与批次编排迁入新包，子 run 机制留核

- **依赖**：E1
- **改动面**：以 E0 归类为准。初判迁出至新包 `packages/subagents`：`scheduler.ts`、
  `schedulerState.ts`、`delegationBatch.ts`、`delegationPolicy.ts`、
  `delegationDistillation.ts`、`routing.ts`、`modelSelection.ts`、`concurrency.ts`、
  `runtime.ts`、`runtimeState.ts`、`toolProfile.ts`、`skillCache.ts`；初判留核：
  `childAgentLoop.ts`、`childAgentToolCalls.ts`、`childModelClient.ts`、
  `childContextCheckpoint.ts`、`childFinishReason.ts`、`childResult.ts`、
  `childToolVisibility.ts` 与硬限；`vite.config.ts`、`tsconfig.app.json`、装配点接线
- **判据**：`runtime/` 对 subagents 的 6 个耦合文件只剩契约 import；
  `pnpm exec vitest run packages/subagents packages/agent-core tools/agents`；`pnpm build`
- **模型**：codex xhigh
- **状态**：TODO

### E3 · 归档治理随包迁出并对接治理脚本

- **依赖**：E2
- **改动面**：以 E0 归类为准。初判：`archiveCapacity.ts`、`archiveIO.ts`、`archiveWriter.ts`、
  `replay.ts`、`jsonl.ts`、`path.ts`、`distill.ts`、`input.ts` 迁至 `packages/subagents`；
  `scripts/subagent-*.js` 治理脚本 import 路径对接
- **判据**：`pnpm subagent:replay` / `subagent:capacity` / `subagent:archive:retention` /
  `subagent:index:compact` / `subagent:skills` 全部可运行；
  `pnpm exec vitest run packages/subagents`；`pnpm build`
- **模型**：codex medium
- **状态**：TODO

### E4 · state/ 的 subagent 视图与归档 atoms 迁移

- **依赖**：E2
- **改动面**：以 E0 归类为准。初判：`packages/agent-core/src/state/` 下 `subagentView*`、
  `subagentArchive*`、`subagentTree*`、`subagentTrace*`、`subagentRunHistoryAtoms.ts`、
  `subagentSkillGovernanceAtoms.ts`、`subagentConversationTreeView.ts`、
  `subagentExecutionTreeView.ts` 迁至 `packages/subagents`；UI import 路径对接
- **判据**：`pnpm exec vitest run packages/subagents apps/web`；`pnpm build`
- **模型**：codex medium
- **状态**：TODO

## F · 收尾

### F1 · 边界执法脚本进 CI

- **依赖**：B2、C2、D2、D4、D5
- **改动面**：新增 `scripts/check-boundaries.js`（`packages/agent-core/src` 禁 import：
  `react`、`@web-agent/tools-`、`@tauri-apps/plugin-sql`、各能力包名）；
  `.github/workflows/ci.yml` 在 check-docs 之后、测试之前接入；根 `package.json` 加 script
- **判据**：脚本在当前树上全绿；人为加一条违规 import 时 CI 判红（本地验证后撤销）；
  `node scripts/check-boundaries.js` 幂等可重跑
- **模型**：codex medium
- **状态**：TODO

### F2 · 文档同步

- **依赖**：A1–F1 全部 DONE
- **改动面**：`CLAUDE.md`「当前结构」、根 `README.md` 仓库结构、
  `docs/core-runtime-flow.md`；按仓库约定删除本 issue 文件并从 `docs/README.md` 移除条目
- **判据**：`node scripts/check-docs.js`；文档描述与 `pnpm build` 通过的实际包结构一致
- **模型**：codex medium
- **状态**：TODO

## 未决（不编号、不排期、不指派模型）

- **宿主桥外移**：`runtime/workspace*.ts`、`shellCommand.ts` 等 14 处 `@tauri-apps/api`
  import 是 ToolContext 能力的 Tauri 实现，外移为宿主桥包是比本树大得多的工程，须另立 issue 树；
  因此 F1 的禁入清单不含 `@tauri-apps/api`。
- **delegation 多实现**：今天只有一个读者，E1 只做「注入」不做「可替换承诺」；
  出现第二个实现需求时再议 port 稳定性。
- **TraceViewer 归属**：先迁 `apps/web`；若未来出现第二个 React 宿主要复用，再议迁
  `packages/agent-react`。
- **CallTiming 与 plugin hook 的长期分工**：CallTiming 已决策引入（A2/A3/B3，见页首）。
  遗留问题是既有 hook 用户（压缩 `transformContext`、finish reason、loop guard 等横切插件）
  是否长期保留在 hook 面——当前答案是保留：变换/拦截型行为（改 draft、拦工具、终止 run）
  不适合工具抽象，CallTiming 只承接「到点产出内容/动作」类需求；若日后出现边界模糊的新场景，
  以「需要记账与位置透明的选工具、需要拦截与变换的选 hook」为判据。
- **`sessionEnd` 不设**：本运行时的会话是持久多会话，没有定义良好的「结束」时刻——切换与
  关闭在 Web 宿主无可靠信号，会话删除前再执行会写 timeline 的工具则自相矛盾。若未来出现
  会话归档钩子需求，先解决「结束时写入」的语义再议；A2 的开放时机面保证届时增补不触碰既有面。
- **MCP 生命周期时机**：本树只交付扩展面（A2 的 `<domain>:<event>` 时机 + A3 的公开分派
  API），`mcp:connected` / `mcp:disconnected` / `mcp:toolsChanged` 等具体时机由 MCP 装配层
  （`apps/web/src/mcp/`）在自己的演进里接入，接入时同步
  [MCP 集成](mcp-integration.md) 文档；注意与 A2 的外部来源校验区分——MCP **工具**永远不得
  自带 `callTiming`，挂 `mcp:` 时机的只能是本地注册的工具。
