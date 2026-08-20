# 线裁决落地 Issue 树

目标：把 [`.project-lines/`](../.project-lines/SKILL.md) 里负责人 2026-08-20 确认的 24 条裁决
全部落地——6 项删除、1 个真实 bug、1 条门禁扩判据、9 项契约/跨包收敛、4 项测试与声明补齐、
4 组文档与注释对齐。裁决原文在各线文件末尾的「裁决」节，问题原文在
[`questions.md`](../.project-lines/questions.md)。

**本树不含方向迁移。**负责人同日裁定「agent 循环跑服务端、前端纯展示」，那是另一个数量级的
工作，单列在未决分支，另开树。本树的 9 项契约收敛与那个方向**同向**（重复判据一律收敛到后端
一份），所以先做不浪费；唯一例外是 idb 相关，已刻意排除在外。

## 树

```text
A 删除与清理    A1 compactionPlugin   A2 delegate 同步分支   A3 SubagentTreePanel
                A4 hostRecoveryFlush  A5 subagent:capacity   A6 CLI 悬空 import
B bug 与门禁    B1 UndoBar 修复       B2 规则 5 扩判据
C 契约与跨包    C1 两个 compact 时机补触发   C2 MCP 工具打 origin   C3 escalation 提共用层
                C4 McpTransport 统一        C5 失败分类收敛后端    C6 openai-compat 补 web 侧
                C7 skill 清单迁回前缀       C8 阶段轨迹并回 registry  C9 档位表按 vendor
D 测试与声明    D1 计划域三工具补测试   D2 skill-manifest 补 .md
                D3 standard 计数同步    D4 共形测试扩四家
E 文档与注释    E1 CLAUDE.md 五处   E2a Tauri 注释群（非 mcp）  E2b Tauri 注释群（mcp）
                E3 core 内注释      E4 docs/ 与 TOOLS-SPEC
未决（不编号、不指派）：方向迁移 · 续跑语义 · beforeToolCall · CLI 定位 · idb 先例 · 6 条未提交
```

并行规则：**A2–A6、B1、C2、C8、C9、D1–D4、E1、E3、E4 十六张无依赖且改动面互不重叠，可并行**。
依赖边只有四条：A1 依赖 C1（先给两个时机补上触发路径，再删插件，否则它们彻底没有主）；
B2 依赖 B1 + A3（两个已知漏网都消掉，扩判据才不会一上来就红）；E2b 依赖 C4 + C5（都改
`tools/mcp/**`，串行避冲突）；C6 依赖 C4（先统一传输类型再补第四家）。
同时在途控制 3–4 张，验收是瓶颈。

## 现状事实（写卡前核实过，是所有卡的共同依据）

- `compactionPlugin` 已于 `d1e1c33` 移出 `defaultPlugins.ts:7-11`，全仓引用这个**值**的只剩它自己
  的测试；`modelTurnRequester.ts:5` 引的是类型。`preCompact`/`postCompact` 的唯一触发方就是它，
  所以这两个时机在生产里从不触发（`modelTurnRequester.ts:153` 是空调用）。
- `UndoBar.tsx:24` 用裸 `useAtomValue` 读 `sessionUndoAvailabilityAtom(id)`，读的是界面 store，
  值恒为默认 → `:30` 恒 `return null`。`UndoBar.test.tsx:20` 把会话 store 当环境 store 传，掩盖了它。
- `check:state` 规则 5 的判据是「从 `@einfach-agent/core` 直接导入的标识符」，抓不到 atom 工厂
  调用，也不认 `@einfach-agent/subagents` 的会话 atom（`agentStoreBinding.js:32,63`）。
- `apps/cli/src/runtime.ts:9` import 了 `configurePersistence` 但从不调用；`tsconfig.app.json:12`
  关了 `noUnusedLocals` 所以不红。CLI 的 trace 只在 `--verbose` 时打 stderr（`runtime.ts:43-58`）。
- `builtinProviders.ts:216-219` 注册四家 provider，`openai-compat` 只有 CLI 能用：
  `providerTransport.ts:28-31` 与 `settings/modelCredentialHost.ts:4-6` 都没有它。
- skill L1 清单现由 `skill-manifest.ts:17` 的 `sessionStart` 到点工具产出（`a88ba16`），
  `modelTurnPrefix.test.ts:38` 断言前缀不再调 `buildManifestText`。
- `MAX_PROJECT_SKILLS` 与 `MAX_DISABLED_SKILLS_PER_WORKSPACE` 已改为 100（本轮已完成，无卡）。
- skill 启停偏好与设置面板**已存在**（`projectSkillPreferences.ts` + `ProjectSkillsPanel.tsx`），
  不要重做。

## 卡

### A1 · 删除 compactionPlugin 及其投影缓存与测试

- **依赖**：C1
- **改动面**：`packages/agent-core/src/runtime/core/plugins/compactionPlugin.ts`、
  `compactionPlugin.{test,reuse.test,timed.test}.ts`、`compactionProjectionCache.ts`、
  `compactionProjectionExtension.test.ts`；`CompactionRequestDraft` 类型迁到
  `runtime/modelTurnRequester.ts` 或 `runtime/core/loopHooks.ts`（择一，卡内说明理由）
- **判据**：`grep -rn "compactionPlugin" packages apps tools --include='*.ts'` 零命中；
  `pnpm exec vitest run packages/agent-core` 绿；`pnpm build` 绿
- **模型**：sonnet
- **状态**：TODO

### A2 · 删除 delegate_agent 同步返回分支并收 ToolContext.delegateAgents

- **依赖**：—
- **改动面**：`tools/agents/src/delegate-agent/delegate-agent.ts:167` 及同目录测试；
  `packages/agent-core/src/runtime/toolContext/` 里 `delegateAgents` 的能力声明与类型
- **判据**：`grep -rn "delegateAgents" packages tools apps --include='*.ts'` 只剩 spawn 那条路；
  `pnpm exec vitest run tools/agents packages/agent-core` 绿；`node scripts/check-boundaries.js` 绿
- **模型**：opus（收的是对外能力面）
- **状态**：TODO

### A3 · 删除 SubagentTreePanel 及其 5 个文件

- **依赖**：—
- **改动面**：`apps/web/src/agentNew/ui/SubagentTreePanel.tsx` 与其同族 4 个文件
  （含 `SubagentSkillGovernancePanel.tsx`）及对应测试
- **判据**：`grep -rn "SubagentTreePanel\|SubagentSkillGovernancePanel" apps` 零命中；
  `pnpm exec vitest run apps/web` 绿；`pnpm check:state` 绿
- **模型**：sonnet
- **状态**：TODO

### A4 · hostRecoveryFlush 收成直调

- **依赖**：—
- **改动面**：`apps/web/src/host/hostRecoveryFlush.ts`、`apps/web/src/main.tsx` 的调用点
- **判据**：不再有只剩一支的 switch/if；`pnpm exec vitest run apps/web/src/main.test.tsx
  apps/web/src/main.serverHost.test.tsx` 绿
- **模型**：sonnet
- **状态**：TODO

### A5 · 删除 pnpm subagent:capacity 命令

- **依赖**：—
- **改动面**：`package.json` 的 `subagent:capacity` 一行；`CLAUDE.md` 子 Agent 治理命令那行
  （只删这一处词条，其余 CLAUDE.md 修正归 E1）
- **判据**：`grep -rn "subagent:capacity" . --include='*.json' --include='*.md'` 零命中；
  `pnpm exec vitest run packages/subagents/src/archive` 仍绿（容量口径仍由该测试钉住）；
  `node scripts/check-docs.js` 绿
- **模型**：sonnet
- **状态**：TODO

### A6 · 删除 CLI 的悬空 configurePersistence import

- **依赖**：—
- **改动面**：`apps/cli/src/runtime.ts:9`（**只动这一行相关的 import**；CLAUDE.md 里「与 CLI
  共用同一份」那两句归 E1，避免与它抢同一个文件）
- **判据**：`grep -n "configurePersistence" apps/cli/src/runtime.ts` 零命中；`pnpm build` 绿；
  `pnpm cli --help` 正常退出
- **模型**：sonnet
- **状态**：TODO

### B1 · 修复 UndoBar 恒不渲染

- **依赖**：—
- **改动面**：`apps/web/src/agentNew/ui/UndoBar.tsx:24`、`UndoBar.test.tsx:20`
- **判据**：组件改用 `useAgentAtomValue`；测试改传 `agentStore`，并**新增一条**「存在可撤销条目时
  组件真的渲染出按钮」的断言（现有断言全绿也证明不了这件事）；`pnpm exec vitest run
  apps/web/src/agentNew/ui/UndoBar.test.tsx` 绿
- **模型**：sonnet
- **状态**：TODO

### B2 · check:state 规则 5 扩到 atom 工厂与 subagents 包

- **依赖**：B1、A3
- **改动面**：`scripts/state-invariants/agentStoreBinding.js`（判据 + 枚举面新表）及其测试
- **判据**：`pnpm check:state` 绿；**新增一条反向用例**——把 `UndoBar.tsx` 临时改回裸
  `useAtomValue(sessionUndoAvailabilityAtom(id))` 时门禁必须红（用 fixture，不动真实文件）；
  `pnpm test` 绿
- **模型**：opus（新判据会被后续照抄）
- **状态**：TODO

### C1 · 给 preCompact / postCompact 补不依赖插件的触发路径

- **依赖**：—
- **改动面**：`packages/agent-core/src/runtime/modelTurnRequester.ts:129-153`、
  `packages/agent-core/src/tools/toolCallTiming.ts`
- **判据**：新增测试——注册到这两个桶的到点工具在 checkpoint 蒸馏前后**各触发一次**且被投影成
  timeline item；`pnpm exec vitest run packages/agent-core/src/runtime` 绿
- **模型**：opus（时机契约，A1 依赖它）
- **状态**：TODO

### C2 · MCP 动态工具打 origin:'external'

- **依赖**：—
- **改动面**：`tools/mcp/src/toolAdapter.ts:388-403` 及同族测试
- **判据**：新增断言「MCP 造出的工具带 `origin:'external'`，且 `toolRegistry.ts:71-77` 的剥
  `callTiming` 分支对它真的生效」；`pnpm exec vitest run tools/mcp` 绿
- **模型**：sonnet
- **状态**：TODO

### C3 · 换模型 escalation 从 subagents 提到共用层

- **依赖**：—
- **改动面**：`packages/subagents/src/modelSelection.ts:138-179` 抽出的共用实现新家
  （`packages/agent-core/src/runtime/` 或 `packages/agent-ai/`，卡内说明选择理由）、
  `packages/agent-core/src/runtime/runToolLoop.ts:160-165`
- **判据**：主 run 遇 `insufficient_system_resource` 与子 run 走**同一条**升档判据（新增对拍测试）；
  `pnpm exec vitest run packages/agent-core packages/subagents` 绿；`node scripts/check-boundaries.js` 绿
- **模型**：opus（跨包 API + 新契约）
- **状态**：TODO

### C4 · McpTransport 联合统一成一份

- **依赖**：—
- **改动面**：`tools/mcp/src/types.ts:27`、`apps/web/src/mcp/types.ts:4` 及两侧消费方
- **判据**：全仓只剩一处 `McpTransport` 联合定义（`grep -rn "type McpTransport"` 一条命中）；
  `pnpm exec vitest run tools/mcp apps/web/src/mcp` 绿；`node scripts/check-boundaries.js` 绿
- **模型**：opus（跨包类型边界）
- **状态**：TODO

### C5 · MCP 失败分类收敛到后端一份

- **依赖**：—
- **改动面**：`tools/mcp/src/failureClassification.ts:97-113`、
  `packages/host-node/src/mcp/errors.ts`、两侧调用方
- **判据**：前端不再自己判分类，`kind` 随错误从后端带回；后端新增/改名一个 kind 时前端无需改动
  （新增测试证明）；`pnpm exec vitest run tools/mcp packages/host-node` 绿
- **模型**：opus（跨进程契约）
- **状态**：TODO

### C6 · openai-compat 补齐 web 侧受限传输与凭证面板

- **依赖**：C4
- **改动面**：`apps/web/src/modelTransport/`、`apps/web/src/settings/modelCredentialHost.ts:4-6`、
  `packages/host-node/src/model/providerRoute.ts` 的端点白名单
- **判据**：web 能配置 openai-compat 并真的发出请求；**白名单语义要在卡内明确**——它的 baseUrl 由
  用户填，精确匹配表在此失效，须给出替代约束（回环/显式许可清单择一）并写进测试；
  `pnpm exec vitest run apps/web packages/host-node` 绿
- **模型**：opus（安全边界，白名单是受限传输的全部价值）
- **状态**：TODO

### C7 · skill L1 清单迁回请求稳定前缀

- **依赖**：—
- **改动面**：`tools/skills/src/skill-manifest/`、`packages/agent-core/src/runtime/modelTurnPrefix.ts`、
  `modelTurnSystemItems.ts:9-13` 注释、`modelTurnPrefix.test.ts:38` 的反向断言
- **判据**：清单回到稳定前缀且 `buildManifestText` 被调用；新增测试证明清单变化被 contextCache
  归因为 `profile_changed`（不是尾巴动态变化）；`pnpm exec vitest run packages/agent-core tools/skills` 绿
- **模型**：opus（缓存契约，改错会让每轮全额 miss）
- **状态**：TODO

### C8 · 阶段轨迹并回 TimelineItemView

- **依赖**：—
- **改动面**：`apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx:44`
- **判据**：改走 registry 分派后渲染结果不变（快照或结构断言）；
  `pnpm exec vitest run apps/web/src/agentNew` 绿
- **模型**：sonnet
- **状态**：TODO

### C9 · 子 Agent 档位路由表按 vendor 选

- **依赖**：—
- **改动面**：`packages/subagents/src/defaultTierRouting.ts`、`tierRouting.ts:13-17`
- **判据**：GLM / Kimi 会话能取到各自的表（新增逐 vendor 测试），deepseek 行为逐字不变；
  `pnpm exec vitest run packages/subagents` 绿
- **模型**：opus（新契约，会被后续 vendor 照抄）
- **状态**：TODO

### D1 · 计划域三个工具补同目录测试

- **依赖**：—
- **改动面**：`tools/planning/src/{create-plan,execute-plan,update-plan}/*.test.ts`（新建）
- **判据**：三个工具各有同目录测试且覆盖各自的失败分支；
  `pnpm exec vitest run tools/planning` 绿
- **模型**：sonnet
- **状态**：TODO

### D2 · skill-manifest 补 .md 说明

- **依赖**：—
- **改动面**：`tools/skills/src/skill-manifest/skill-manifest.md`（新建）+ 工具声明引用它
- **判据**：文件存在且被工具声明引用；`pnpm exec vitest run tools/skills` 绿；
  `node scripts/check-docs.js` 绿
- **模型**：sonnet
- **状态**：TODO

### D3 · tools/standard 计数注释与权威清单同步

- **依赖**：A2（工具数会变）
- **改动面**：`tools/standard/src/index.ts:4,6,30` 的计数注释
- **判据**：注释里的域数与工具数与 `index.test.ts:12-41` 的清单逐一对上；
  `pnpm exec vitest run tools/standard` 绿
- **模型**：sonnet
- **状态**：TODO

### D4 · provider 共形测试扩到四家

- **依赖**：—
- **改动面**：三份 `packages/agent-ai/src/*.characterization.test.ts` 的 `PROVIDERS` 数组
- **判据**：四家全跑；kimi 与 openai-compat 的**已知差异**在测试里显式声明而不是被跳过；
  `pnpm exec vitest run packages/agent-ai` 绿
- **模型**：sonnet
- **状态**：TODO

### E1 · CLAUDE.md 五处修正

- **依赖**：A5、A6（它们各自删掉一个词条，避免抢同一文件）
- **改动面**：`CLAUDE.md:125`（四家 provider）、`:291`（压缩不再是插件）、`:304-305`（与 CLI 共用
  库文件不成立）、`:311`（CLI 不写 trace 库）、`:352`（fallback 落点是 runToolLoop）
- **判据**：五处逐条改完；`node scripts/check-docs.js` 绿；改后的每句都能被一条 `grep` 证实
- **模型**：sonnet
- **状态**：TODO

### E2a · 清理 Tauri 残留注释（非 mcp 部分）

- **依赖**：—
- **改动面**：`packages/persistence-sqlite/src/*`、`packages/observability-sqlite/src/*`、
  `apps/server/src/health.ts:30,34`、`packages/agent-core/src/runtime/turnToolVisibility.ts:41-53`、
  各 `tools/<域>` 里写「依赖 Tauri」的注释
- **判据**：`grep -rn "Tauri\|tauri" packages tools apps --include='*.ts' --include='*.rs'`
  只剩 mcp 那批（归 E2b）；`pnpm build` 绿
- **模型**：sonnet
- **状态**：TODO

### E2b · 清理 Tauri 残留注释（tools/mcp 的 12 个文件）

- **依赖**：C4、C5（同改 `tools/mcp/**`，串行避冲突）
- **改动面**：`tools/mcp/src/` 里以已删的 `tauriStdioConnector.ts` 为对照系的 12 个文件注释
- **判据**：`grep -rn "tauri" tools/mcp` 零命中；`pnpm exec vitest run tools/mcp` 绿
- **模型**：sonnet
- **状态**：TODO

### E3 · core 内失效注释修正

- **依赖**：C1（loopHooks 的槽位描述会随它变）
- **改动面**：`packages/agent-core/src/runtime/core/loopHooks.ts:7-11,171`、
  `scripts/state-invariants/sessionAtomSource.js:16-19`、
  `packages/agent-core/src/runtime/commands/historyCommands.ts:99`、四个插件的头注释（仍指 `modelRun.ts`）
- **判据**：每条注释描述的事实能被一条 grep 证实；`pnpm test` 绿
- **模型**：sonnet
- **状态**：TODO

### E4 · docs/ 六处与 TOOLS-SPEC 四处对齐

- **依赖**：C7（skill 清单位置会随它变）
- **改动面**：`docs/core-runtime-flow.md:52,105`、`docs/tree-subagent-runtime.md:144`、
  `docs/mcp-integration.md`、`docs/project-skills-blueprint.md`（`ensureProjectSkills` 已不存在）、
  `docs/skills-tree-blueprint.md`、`packages/agent-core/src/tools/TOOLS-SPEC.md`（注册点、31 的口径、
  skills 域少列一个、Tauri 措辞）
- **判据**：逐条对上代码；`node scripts/check-docs.js` 绿
- **模型**：sonnet
- **状态**：TODO

## 未决（不编号、不指派模型；决策没落地，依赖它的卡不开工）

- **方向迁移：agent 循环跑服务端、前端纯展示。** 负责人 2026-08-20 已裁定方向，但范围是另一个
  数量级（core 从浏览器搬到 `apps/server`，`static` 态失效，idb driver 可能整条作废，三层 store
  重画）。**另开树**，不混进本树。
- **子 Agent 续跑语义**（questions A5）：负责人的意思读作「两个 disposition 是过度设计，真正要的
  是死循环可观测、可关掉、可重开」——待确认；且「关掉再重开」现在有没有尚未核实。
- **beforeToolCall 给不给第三方插件**（questions A6）：已定「插件一视同仁」，但该 hook 能返回
  `{block:true}` 拦下工具调用，等于让第三方能否决 shell 命令、改模型看到的上下文。
- **CLI 定位**（questions B1）：暂定「一次性工具」，方向迁移落地后重开。
- **idb 先例**（questions B6）：`observability-sqlite` 依赖 `observability-idb` 算不算通用模式；
  与方向迁移一并定。
- **`sourceFiles.js:13` 扫描面含 `dist/`**（questions D4）：答「不知道」，保持未决；下一条按行
  扫描的规则**不要**直接复用这份文件清单。
- **合并时未提交的 6 条**（00-3、00-4、11-3、12-1、14-4、16-4）：判为不改变新代码去向而未上会，
  各自记在对应线文件的裁决节里。
