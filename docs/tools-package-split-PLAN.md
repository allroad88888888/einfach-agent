# Tools 多包拆分规划（TSPLIT）

> 承接 agent-ai / agent-core / app 三包拆分。本轮把 **21 个具体工具** 从 `@web-agent/core`
> 拆出为**多个** tool 包（每包多工具，按能力域分组）。工具**抽象**留在 core。

## ✅ 落地状态（TS1 + TS2 已完成并验证）

- **TS1 登记反转**：`createCoreInstance` 不再自动 `registerStandardTools`，加 `registerTools?` 钩子；`defaultCore` 无工具；`main.tsx` + `test/setup.ts` 各一行经 meta 恢复默认。**未挪文件即全绿证成立。**
- **TS2 拆包**：21 工具 → 6 域包（`@web-agent/tools-{shell,interaction,fs,planning,skills,agents}`）+ meta `@web-agent/tools`；空目录 evaluate-plan/evaluate-stage 删除；`core/tools/register.ts` 删除（角色移交 meta）。
- **测试归属**：core 隔离测试（coreInstance/createCore/isolation）改用 **fake 工具**保持对具体工具无知；`toolLoading.test`（真 save_file 懒加载）+ apply-patch 复杂 schema 校验块迁到 `tools-fs`；「标准 21 工具就位」断言归 `@web-agent/tools` 的 index.test。
- **三道门全绿**：`tsc -b` clean · **983 tests pass** · `vite build` 成功（460 模块）。
- **架构不变量已验证**：core 源码**零依赖**任何 tool 包（无主张 core 成立）；各域包**仅依赖 core**、无横向耦合；meta 依赖 6 域。拓扑 `ai ← core ← tools-* ← tools(meta) ← app`，单向无环。

### codex review（--uncommitted）结论 + 修复

跑了 `codex review --uncommitted`，2 条发现，均真实、均已修：

- **[P1] modelTurn.ts:94 —— manifest enum 漏穿 core（已修）**：`request_tool_schema` 的 toolName enum 硬读模块级 `toolRegistry`（=defaultCore.tools）。登记反转让「隔离 core 装自定义工具集」成真特性后，该 gap 会使自定义 core 的工具进不了 manifest、却广播 defaultCore 的工具。修法：`BuildTurnToolsOptions` 加 `registry?`，enum 读 `options?.registry ?? toolRegistry`，`modelRun.ts` 调用点传 `core.tools`。加回归测试（modelTurn.test：自定义 registry 的工具进 enum、defaultCore 标准工具不进）。主派发（modelRun:746/1119 `core.tools.run`）本就 core-aware，故此修让主路径的自定义工具集端到端自洽；subagent 路径（toolContext:402 / subagents）是另一条已文档化的 Phase 2.5 延后 gap，本次不动。
- **[P2] agent-core/package.json —— 缺运行时依赖声明（已修）**：core 只声明 `@web-agent/ai`，却直接 import `@einfach/core`/`@tauri-apps/{api,plugin-sql,plugin-dialog}`（补为 dependencies）+ `react`/`@einfach/react`（补为 peerDependencies，避免双份 React）。此前只因 root 包碰巧提供才 build 通。tool 包零外部依赖，无此问题。

### 清洁复审（第二次 `codex review --uncommitted`）+ pnpm 收口

修完 P1/P2 后重跑复审：**上轮 P1/P2 未被再提（已消解）**，拆分实现与测试评为 "otherwise appearing sound"。仅 1 条新发现，已处理：

- **[P1] `workspace:*` 破坏全新 `npm install`（已改为 pnpm）**：`workspace:*` 是 pnpm/yarn 语法，root 无 npm `workspaces` 字段、`package-lock.json` 不含新包 → 全新 `npm install` 报 `EUNSUPPORTEDPROTOCOL`。此问题**预先存在**（agent-ai/agent-core 拆分即引入 `workspace:*`），是 npm↔pnpm 半迁移。**决策：全面转 pnpm**（仓库已有 pnpm-workspace.yaml + pnpm-lock.yaml）——CLAUDE.md 命令 `npm*` → `pnpm*`、删除过时 `package-lock.json`、保留 `workspace:*`。验证：`pnpm install`（10 workspace projects）→ `pnpm build` ✓ → `pnpm test` 983 ✓。
- **注意**：`pnpm-lock.yaml` + `pnpm-workspace.yaml` 目前 untracked，需随本轮一起 commit，全新 checkout 才能 `pnpm install` 跑通。

**最终状态**：TS1+TS2 + 两轮 review 收口全部完成；三门全绿；文档化工作流已切 pnpm。

---

## 1. 依赖真相（已 grounding，非估计）

唯一的 `core → 具体工具` 边只有一条：`runtime/core/coreInstance.ts:114` 的
`registerStandardTools(tools)`（经 `import ... from '../../tools/register'`）。
其余所有对 `tools/` 的引用（`subagents/runtime`、`runtime/toolLoading`、`runtime/core/pluginApi` …）
都只 import **抽象**（`tools/types` / `tools/registry` / `tools/toolRegistry`）——这些留在 core。
**剪断那一条边（登记反转），具体工具对 core 就零入边，拆包无环。**

| 能力域 | 工具 | 对 core 的依赖（抽象之外） |
|---|---|---|
| shell/桌面 | shell-macos, shell-linux, shell-powershell, run-task, git-diff-review | **无**（纯 ctx 白名单） |
| 交互/产物 | ask-user-question, browser-action, save-file | **无**（纯 ctx 白名单） |
| 文件系统 | read-file, list-files, search-files, rg-search, apply-patch, write-file | `runtime/workspace*` **仅 type-only**（编译期擦除，invoke 走 ctx） |
| planning | create-plan, update-plan, execute-plan, submit-stage-result | `planning/{types,runtime}` + `evaluation/runtime` + `subagents/types`（真依赖；submit-stage-result 最重） |
| skills | skill-search, skill-read | `skills/registry`（真依赖） |
| subagents | delegate-agent | `subagents/input`（真依赖） |

- `write-file` / `execute-plan` 虽在 fs/planning 域，但实际只 import `../types`（走 ctx），依赖比同域其他工具更轻——按**域**归组即可。
- `evaluate-plan` / `evaluate-stage`：**空目录**，未注册，顺手删。
- 真实工具 = register.ts 的 **21** 个。

## 2. 使能动作：登记反转（TS1）—— 一切的前提

- `createCoreInstance` 不再自动 `registerStandardTools`；改为**消费方注册**（core 变无主张，pi 终态）。
- `createCoreInstance(opts)` 增 `registerTools?(registry): void` 钩子。**过渡期**默认仍装标准工具（保绿），**最终**移除对 `../../tools/register` 的 import——这一步物理剪断唯一的 core→工具边。
- batteries-included 不丢：由 meta 包 `@web-agent/tools` 导出 `registerStandardTools`，`app` 与 `test-setup` 各一行调用即恢复"默认 21 工具"。

## 3. 目标拓扑

```
@web-agent/ai (叶子：模型 API)
  ↑
@web-agent/core (状态 / 运行时 / planning / subagents / skills / evaluation / 【工具抽象】；不再自动装工具)
  ↑          ↑            ↑              ↑             ↑
tools-shell  tools-fs  tools-planning  tools-skills  tools-…   (各 → core，每包多工具)
  ↑__________↑____________↑______________↑_____________↑
                    @web-agent/tools (meta：聚合各域 registrar + registerStandardTools)
                                      ↑
                                    app (选装：注册想要的 tool 包进 core.tools)
```

无环：所有 tool 包 → core（单向）；core 不 import 任何 tool 包。app → meta → 各域包 → core。

## 4. 分组方案（3 档粒度，供选）

**A · 6 域包（推荐，域最清晰）**

| 包 | 工具数 | 工具 | 依赖 |
|---|---|---|---|
| `@web-agent/tools-shell` | 5 | shell×3, run-task, git-diff-review | core（仅抽象） |
| `@web-agent/tools-interaction` | 3 | ask-user-question, browser-action, save-file | core（仅抽象） |
| `@web-agent/tools-fs` | 6 | read/list/search-files, rg-search, apply-patch, write-file | core（抽象 + workspace* type-only） |
| `@web-agent/tools-planning` | 4 | create/update/execute-plan, submit-stage-result | core（planning+evaluation+subagents） |
| `@web-agent/tools-skills` | 2 | skill-search, skill-read | core（skills） |
| `@web-agent/tools-agents` | 1 | delegate-agent | core（subagents） |

**B · 4 层包（按依赖层级，少样板）**：`tools-basic`(全部 ctx-only=8) / `tools-fs`(type-only=5) / `tools-planning`(4) / `tools-cognition`(skills+agents=3)。

**C · 3 粗包（最少包）**：`tools-std`(basic+fs=13) / `tools-planning`(4) / `tools-cognition`(3)。

＋ 三档都配 meta `@web-agent/tools`。

## 5. 决策 Fork：抽象放哪

- **Fork A（本轮采用）抽象留 core**：`types/registry/toolRegistry/schemaValidate` 不动。最简、无环、零抽象改动。包边界靠约定 + review（所有 tool 包都依赖整块 core，package.json 层面拦不住"shell 工具误 import planning"）。
- **Fork B（未来可选）抽象提叶子 `@web-agent/tool-kit`**：ctx-only 工具只依赖 tool-kit → **编译期强制**"这些工具只碰抽象"。但需先给 `types.ts` 解耦 `planning/types`+`subagents/types`（`ToolContext` 的可选能力引了它们）——要么把这两个类型文件也搬进 tool-kit，要么把 ToolContext 的 planning/subagent 能力 genericize。侵入较大，**本轮不做**。

## 6. 成本 / 风险

- **主成本 = 测试搬迁**：core 内假设"defaultCore 已装 21 工具"的测试（`toolLoading` / `modelTurn` / `coreInstance` / `pluginApi` / `headlessConsumer` 等）——要么随工具搬到对应包（colocated），要么改成注册一个 fake tool。与 agent-core 拆分时的 46 处 `vi.mock` 路径重写同类、可控。
- **样板**：每包 `package.json` + `tsconfig.json` + vite `resolve.alias` + tsconfig `paths` 各一处（档次越细越多）。
- `evaluate-plan` / `evaluate-stage` 空目录顺手删。

## 7. 迁移顺序（先立缝后拆包，复刻已验证的三包流程）

1. **立缝（TS1 登记反转）**：`createCoreInstance` 停止自动注册；`app` + `test-setup` 显式调 `registerStandardTools`。**此步不挪任何文件**——全绿即证反转成立，风险隔离。
2. **拆包（TS2）**：`git mv` 各工具目录 → `packages/tools-*/src/`；建 `package.json`/`tsconfig.json`；wire vite alias + tsconfig paths；`register` 内 import 改 `@web-agent/tools-*`；建 meta 包 `@web-agent/tools`。
3. **收尾（TS3）**：搬/改 core 内工具相关测试；`npm run build` + `npm test` 全绿；`codex review --uncommitted`。
