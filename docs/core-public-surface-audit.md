# `@einfach-agent/core` 公开面收敛盘点

> **这是盘点 + 蓝图，不是当前实现。** 本文只枚举现状、归类并提出白名单方案，**没有改动任何
> 源码或包配置**。文中的"建议 subpath"全部尚未存在，引用前必须核对实现。
>
> 上游来源：[npm 发包方案蓝图](launch/npm-publish-plan.md) 的 **G4** 与"执行前的阻塞项"第 3 条。

## 1. 为什么只有 core 需要这张卡

18 个 workspace 包里，**只有 `@einfach-agent/core` 的 `exports` 是通配 `"./*": "./src/*"`**，
其余全部已经是"barrel + 零到少量显式 subpath"。核对命令：

```bash
for p in packages/*/package.json tools/*/package.json apps/cli/package.json; do
  node -e "const p=require('./$p');console.log(p.name, JSON.stringify(p.exports))"
done
```

结论：通配意味着 `src/` 下**任何**文件都是公开承诺，任何内部重构都是 breaking change。
其他包不需要同类盘点，只有两条搭便车的清理项（见第 6 节）。

## 2. 复现命令与数字

全部数字来自以下三条命令（在仓库根执行，`apps packages tools` 三个目录，`.ts`/`.tsx`）：

```bash
# 2.1 全量深导入按出现次数排序
grep -rhoE "from '@einfach-agent/core/[^']+'" apps packages tools \
  --include='*.ts' --include='*.tsx' | sort | uniq -c | sort -rn

# 2.2 拆测试/非测试两个口径，并算去重后的子路径数
grep -rlE "from '@einfach-agent/core/" apps packages tools --include='*.ts' --include='*.tsx' \
  > /tmp/core-importers.txt
grep -vE '\.test\.(ts|tsx)$|/test/|/__tests__/|testUtils|\.mock\.' /tmp/core-importers.txt \
  > /tmp/core-nontest.txt
grep -E '\.test\.(ts|tsx)$|/test/|/__tests__/|testUtils|\.mock\.' /tmp/core-importers.txt \
  > /tmp/core-test.txt
xargs grep -hoE "from '@einfach-agent/core/[^']+'" < /tmp/core-nontest.txt \
  | sed "s|from '||;s|'$||" | sort -u | tee /tmp/nt.txt | wc -l   # 63
xargs grep -hoE "from '@einfach-agent/core/[^']+'" < /tmp/core-test.txt \
  | sed "s|from '||;s|'$||" | sort -u | tee /tmp/t.txt | wc -l    # 37
sort -u /tmp/nt.txt /tmp/t.txt | wc -l                            # 68
comm -13 /tmp/nt.txt /tmp/t.txt                                   # 仅测试在用：5 条

# 2.3 每条子路径的消费方（包级）
while IFS= read -r f; do b=$(printf '%s' "$f" | cut -d/ -f1-2)
  grep -hoE "from '@einfach-agent/core/[^']+'" "$f" \
    | sed "s|from '@einfach-agent/core/||;s|'$||" \
    | while IFS= read -r p; do printf '%s\t%s\n' "$p" "$b"; done
done < /tmp/core-nontest.txt | sort -u \
  | awk -F'\t' '{a[$1]=a[$1]", "$2} END {for (k in a) printf "%-44s %s\n", k, substr(a[k],3)}' | sort
```

| 口径 | 去重子路径数 | import 语句出现次数 |
| --- | --- | --- |
| 非测试文件 | **63** | 282 |
| 测试文件 | **37** | 200 |
| 并集（公开面实际承诺） | **68** | 482 |
| 仅测试在用（非测试口径为零） | **5** | — |

> G4 原文写的是 61，本次实测 **68**。差额是这份蓝图写就之后新增的深导入——数字会继续漂，
> 所以本文只承诺命令可复现，不承诺常数。另有 `scripts/` 里 1 处消费方
> （`subagent-replay-lib.test.js` 用 `@einfach-agent/subagents/archive/replay`），不属 core。
> 仓库内 **`from '@einfach-agent/core'` 裸 barrel 导入为 0**——因为 core 根本没有 barrel。

## 3. 归类（68 条，每条只落一类）

| 类别 | 条数 | 含义 |
| --- | --- | --- |
| A 宿主装配 API | 21 | `apps/web`、`apps/cli` 装配与 UI 读 atom 所需 |
| B 插件作者 API | 2 | 已经是 curated 单一入口，`docs/plugin-quickstart.md` 教的就是它 |
| C 能力包接缝 | 32 | 工具域 / subagents / persistence-\* / observability-\* 依赖的契约 |
| D 仅测试在用 | 5 | 非测试口径为零，**不该进公开面** |
| E 疑似内部泄漏 | 8 | 非测试消费方直接 import 了实现细节，逐条点名见 3.5 |

### 3.1 A · 宿主装配 API（21）

`execution/graph`、`observability/performanceDiagnostics`、`observability/port`、
`observability/trace`、`plugins/manifestTypes`、`plugins/pluginLoader`、
`plugins/pluginLoaderTypes`、`plugins/pluginScanner`、`runtime/askUserQuestion`、
`runtime/commands`、`runtime/core/coreInstance`、`runtime/core/events`、
`runtime/persistenceBridge`、`runtime/workspaceDialog`、`skills/projectSkillPreferences`、
`state/core.type`、`state/rootStore`、`state/sessionAtoms`、`state/transientAtoms`、
`state/workspaceState`、`tools/registry`

消费方全部是 `apps/web` 与 `apps/cli`（`runtime/askUserQuestion` 另被 `tools/interaction`
共用，`observability/trace` 另被 `packages/subagents` 共用）。

**重复通路**：`tools/registry` 导出的 `toolRegistry` 就是 `defaultCore.tools`
（见 `packages/agent-core/src/tools/registry.ts:17`），与 `runtime/core/coreInstance` 是同一对象
的两条路。白名单只应保留一条。

### 3.2 B · 插件作者 API（2）

| subpath | 现状 | 消费方 |
| --- | --- | --- |
| `plugin` | 已是 curated 入口（[`plugin.ts`](../packages/agent-core/src/plugin.ts) 首行自称"唯一公开入口"） | `apps/web`、`packages/agent-plugin-example` |
| `timeline` | 已是 curated 入口（[`timeline.ts`](../packages/agent-core/src/timeline.ts)，renderer-neutral 投影） | `apps/web`、`packages/agent-react` |

这两条是**白名单该有的样子**，其余 66 条照它们改造即可。桌面契约模块桥当前**只桥
`@einfach-agent/core/plugin` 一个说明符**（见 [插件上手](plugin-quickstart.md) 当前边界第 4 条），
白名单调整时这条硬编码必须同步。

### 3.3 C · 能力包接缝（32）

| 接缝 | subpath | 消费方 |
| --- | --- | --- |
| 工具契约 | `tools/types`、`tools/toolRegistry`、`tools/schemaResult` | 七个工具域 + `tools/standard` + `apps/web`（MCP 探针） |
| workspace 桥 | `runtime/workspaceRead`、`runtime/workspaceRg`、`runtime/workspacePatch`、`runtime/workspaceChange`、`runtime/hostPlatform` | `tools/fs`、`tools/shell` |
| 危险工具/MCP | `runtime/dangerousTools` | `tools/mcp`、`apps/web` |
| 计划 | `planning/types` | `tools/planning`、`apps/web` |
| Skills | `skills/contracts`、`skills/projectSkills` | `tools/skills`、`apps/web` |
| 持久化 driver | `state/persistence/contract`、`state/persistence/historyDriver`、`state/checkpoint.type` | `persistence-idb`、`persistence-sqlite` |
| 观测 driver | `observability/types`、`observability/logReader` | `observability-idb`、`observability-sqlite`、`apps/web` |
| 委派机制 | `runtime/delegationContract`、`runtime/subagentTranscript`、`state/stateViewPort`、`execution/types`、`subagents/{childAgentLoop,childModelClient,delegationPolicy,delegationRuntimePorts,input,modelSelection,path,runtimeState,tierRouting,toolProfile,types}` | `packages/subagents`、`tools/agents` |

**委派接缝是最宽的一处**：`packages/agent-core/src/subagents/` 共 20 个非测试文件，
其中 **12 个**被外部深导入（`packages/subagents/src/delegationBatch.ts` 一个文件就引了 6 条）。
它是"core 的子 run 机制"和"subagents 包的编排层"之间的真实缝，不是随手 import，
但必须收成一个显式 barrel，否则 core 的 subagents 目录等于全公开。

### 3.4 D · 仅测试在用（5）——不进公开面

`runtime/core/pluginContracts`、`runtime/core/pluginHost`、`runtime/skillGovernance`、
`state/sessionWriters`、`tools/schemaValidate`

其中 `state/sessionWriters` 尤其明确：[`CLAUDE.md`](../CLAUDE.md) 写死"UI 不直接调用 writer"，
它出现在跨包测试里而不出现在产品代码里，正是规则生效的证据。这 5 条的迁移方向是让跨包测试改走
白名单入口，或把用例挪回 core 包内用相对路径。

S7b 之后 `state/sessionStore` 也落到这一类（E7 处置掉了它唯一的产品消费方），S8 按同一口径处理，
届时这类是 6 条。

**S8 处置结果**（只改测试文件，未新开任何 barrel 导出）：

| subpath | 消费方（改前） | 处置 |
| --- | --- | --- |
| `runtime/core/pluginContracts` | `apps/web/src/plugins/desktopProvider.test.ts`、`apps/cli/src/plugins.test.ts`（fixture 字面量） | **已消**：`definePlugin` 本就在 `./plugin` 白名单里，两处改走 `@einfach-agent/core/plugin` |
| `runtime/core/pluginHost` | `apps/web/src/plugins/{desktopProvider,desktopImportModule.bridge}.test.ts` | **已消**：两处内联 `createPluginHost(createToolRegistry(), [])` 换成 `createCore().plugins`（`createCore` 同样在 `./plugin` 白名单里，效果等价——都是一个空工具注册表上的隔离 `PluginHost`） |
| `runtime/skillGovernance` | `packages/subagents/src/state/subagentSkillGovernanceAtoms.test.ts` | **已消**：`prepareSubagentSkillGovernance` 本就经 `subagentStatePort.prepareSkillGovernance` 挂在 `./subagents` 白名单里（见 `state/stateViewPort.ts`），测试改走它 |
| `state/sessionWriters` | `apps/cli/src/event-renderer.test.ts` | **已消**：测试实际验证的是 `subscribeCliRenderer` 对 `itemsAtom` 变化的反应，不是写入器本身；换成两个文件内 helper，直接对 `defaultCore.getSessionStore(id).store` 做 `itemsAtom` 的不可变更新（`defaultCore`/`itemsAtom` 都已在白名单），不复现 `touchSession` 副作用（本文件断言从不依赖它） |
| `tools/schemaValidate` | `tools/fs/src/apply-patch/apply-patch.schema.test.ts` | **改不动，留作 S9 豁免候选**：`validateAgainstSchema` 在 core 内部同样零非测试消费方（S1a 已判 D 类、明确排除出 `./tools`），补白名单属于新开公开 API，超出"只改测试文件"的边界；搬回 core 包内会反向撤销 TSPLIT TS2 的既有决定（该测试当初就是为了不让 core 的通用 schema 测试反向依赖具体工具才搬来 `tools/fs` 的）。现状：`check-boundaries.js` 的 `typescriptFiles()` 本就跳过 `*.test.ts`，S9 若延续这个既有惯例，这条深导入天然不会被判红——留给 S9 落地时核实 |

`state/sessionStore` 的 3 处测试脚手架（`apps/web/src/agentNew/ui/{ActiveSessionProvider,AppShell}.test.tsx`
与 `apps/web/src/test/setup.ts` 的 `resetSessionStores`）**已消**：`getSessionStore`/`resetSessionStores`
在 `state/sessionStore.ts` 里就是 `defaultCore.getSessionStore`/`defaultCore.resetSessionStores` 的薄委托
（见该文件"实例化 · 第 1 期"注释），三处改走 `defaultCore`（`runtime/core/coreInstance`，A 类白名单）
的同名实例方法，行为逐字不变。

D 类清单 S8 后剩 1 条（`tools/schemaValidate`，测试专用、不进白名单），其余全部改走已有白名单入口。

### 3.5 E · 疑似内部泄漏（8）——逐条点名

| # | subpath | 泄漏点（非测试消费方） | 为什么算泄漏 | 处置结论 |
| --- | --- | --- | --- | --- |
| E1 | `runtime/core/plugins/compactionPlugin` | `apps/web/src/agentNew/ui/ContextStats.tsx:11` | 压缩是**默认插件实现**（`runtime/core/plugins/`），UI 直接 import 插件内部意味着换插件即破 UI | **已消（S7a）**：换正式通路 `runtime/contextBudget`（符号真正的归属文件），并删掉插件里那段把它原样转出的 re-export |
| E2 | `runtime/core/plugins/finishReasonPlugin` | `packages/subagents/src/delegationDistillation.ts:4` | 同上；能力包依赖 core 的某个默认插件文件路径 | **已消（S7a）**：判据 + 三份文案抽到中立的 `runtime/finishReason`，插件与 loop 一样只当消费方 |
| E3 | `observability/traceCacheTotals` | `apps/web/src/agentNew/ui/ContextStats.tsx:7` | 从 trace 反推缓存总量的补偿逻辑，是观测内部实现而非观测契约 | **补 barrel + 记债（S7a）**：无等价公开 API 可换，收进 `./observability`；债见下方 |
| E4 | `state/persistence/hydrate` | `apps/web/src/main.tsx:23` | 持久化启动步骤；宿主已有 `runtime/persistenceBridge` 这条正式收口 | **已消（S7a）**：`persistenceBridge` 新增 `hydratePersistence()`，读回用桥自己那对 driver |
| E5 | `state/persistence/sessionsPersistence` | `apps/web/src/main.tsx:27` | 同 E4，内部工厂被装配层直接拼 | **已消（S7b）**：那本就是个 IndexedDB 实现，搬去 `@einfach-agent/persistence-idb` 并更名 `createIndexedDbSessionsPersistence`（与 `createIndexedDbHistoryDriver` 同包同载体，对称于 sqlite 侧的 `createSqlitePersistence`）；core 只留 `SessionsPersistence` 契约 |
| E6 | `state/persistence/memoryHistoryDriver` | `apps/cli/src/runtime.ts:10` | core 内的内存 driver 实现被 CLI 当产品依赖 | **补 barrel（S7b）**：判定它该算公开面——零宿主依赖（只 import 本目录两个类型）、语义就是"进程内 Map 不落盘"、是 `HistoryDriver` 契约的参考实现，且 `apps/cli` 是真实产品消费方。收进 `./persistence`，CLI 改走 barrel |
| E7 | `state/sessionStore` | `apps/web/src/agentNew/ui/ActiveSessionProvider.tsx:15` | `getSessionStore` 把 runtime store 交给 UI，与 [`CLAUDE.md`](../CLAUDE.md) 的"UI 不持有 runtime store"直接冲突 | **已消（S7b）**：命令面补一条受限只读通路 `sessionAtomScope(id)`（[`runtime/commands/sessionScopeCommands.ts`](../packages/agent-core/src/runtime/commands/sessionScopeCommands.ts)）——只给"该会话的 atom 作用域"供 `<Provider>` 绑定，**不给** store 生命周期（建/丢/清仍归 `newSession`/`removeSession`）。没有补 barrel |
| E8 | `subagents/concurrency` | `packages/subagents/src/delegationBatch.ts:1` | `createConcurrencyLimiter` 是通用并发原语，不属委派契约 | **归位（S7b）**：搬到 `runtime/concurrencyLimiter`，与同层的 `runtime/writeQueue`、`runtime/newId` 一样是零依赖原语；core 侧 `subagents/runtimeState` 与包侧 `delegationBatch` 都改指新路径，`subagents/` 目录不再混装通用工具。跨包深导入本身留给 S11（它本就把 concurrency 列在 `delegationBatch` 的 5 条里）。**已随 S11 清偿**：S11d 把批次执行段下沉回 core，包侧那个文件连同这条深导入一起消失，`createConcurrencyLimiter` 现在只有 core 内的相对消费方 |

E1–E3、E8 的处置是"要么补进对应 barrel 成为正式 API，要么给消费方换等价公开 API"；
E4–E7 的处置**倾向后者**——正式通路（`persistenceBridge` / commands / atoms）已经存在。
S7a/S7b 落地后 8 条全部有结论：E1、E2、E4、E5、E7 换正式通路，E3、E6 补 barrel，E8 先归位、
剩下的跨包接缝交 S11——**该接缝已随 S11 清偿**（见下方 S7b 债注）。

**S7a 记的两笔债**（E1–E4 已处置，但留下两处要在后续卡兑现）：

- **E3 的公开面是补偿逻辑，不是长期契约**：`cacheTotalsFromTrace` /
  `recoverCacheTotalsFromTrace` 只在「内存里的 cacheTotals 与当前 runId 对不上」时回读本地
  trace，本质是 contextStats 未落盘留下的补丁。contextStats 一旦有自己的持久化，这两个函数
  连同 `observability/traceCacheTotals` 一起删——届时要同步收窄 `./observability` barrel。
- **E1 换出来的 `runtime/contextBudget` 尚无 barrel**：它是纯常量 + 纯函数（`COST_SOFT_CAP_TOKENS`
  / `contextInputBudgetTokens`），语义本就该对宿主公开，但当前只能靠 `./*` 通配解析。
  S5a 建根 barrel 时必须把它一并收进 `.`，否则 S9 的白名单门禁会把 `apps/web` 判红。
  同理 E2 抽出的 `runtime/finishReason` 是 `packages/subagents` 的接缝，S2a 的 `./subagents`
  barrel 或根 barrel 需覆盖它。

**S7b 记的两笔债**（E5–E8 已处置，同样留下两处后续兑现）：

- **E8 归位后跨包深导入还在** —— **已随 S11 清偿**。原状：`packages/subagents` 的批次执行段
  深导入 `@einfach-agent/core/runtime/concurrencyLimiter`，路径诚实了（通用原语不再冒充委派契约），
  但白名单里仍没有这条——与 `runtime/finishReason` 同一处境。当时给的两条出路里，S11 走了第一条：
  S11d 把批次执行段下沉回 core（`subagents/delegationBatch.ts`），包侧那个文件随之消失，
  这条深导入的消费方自动归零，不必为它并 barrel，更不必单开第 10 条 subpath。
  `runtime/finishReason` 同步归零（S11 收掉包侧消费方后已无跨包引用）；`contextBudget` 则早已按
  E1 的原方案收进根 barrel（`COST_SOFT_CAP_TOKENS` / `contextInputBudgetTokens`）。
- **E7 消解后 `state/sessionStore` 降级为仅测试在用**：产品代码里已无消费方，剩下
  `apps/web/src/agentNew/ui/{ActiveSessionProvider,AppShell}.test.tsx` 与
  `apps/web/src/test/setup.ts`（`resetSessionStores`）三处测试脚手架。它按 §3.4 的口径归 D 类，
  由 S8 一并改道（测试要 `setter` 写种子数据，不该走 `sessionAtomScope` 这条只读通路假装合规）。

## 4. 白名单方案：68 → 9

建议的公开 subpath 清单（外加 `./package.json`），每条一个显式 barrel 文件：

| # | subpath | 覆盖原子路 | 消费方 |
| --- | --- | --- | --- |
| 1 | `.`（新建 `src/index.ts`） | A 类 21 条（去掉 `tools/registry` 重复通路）+ S7a 换出来的 `runtime/contextBudget` | `apps/web`、`apps/cli` |
| 2 | `./plugin` | 已存在，不动 | 外部插件作者、`plugin-example` |
| 3 | `./timeline` | 已存在，不动 | `agent-react`、`apps/web` |
| 4 | `./tools` | `tools/types`、`tools/toolRegistry`、`tools/schemaResult` + workspace 桥 5 条 | 七个工具域、`tools/standard` |
| 5 | `./subagents` | 委派接缝 15 条（含 `delegationContract`、`stateViewPort`、`execution/types`）。**已随 S11 清偿**：`runtime/concurrencyLimiter` 与 `runtime/finishReason` 两条跨包接缝的消费方都被 S11 收回 core，barrel 不必覆盖它们；委派执行段下沉后本 barrel 只留协议词汇 + 端口 + 工厂，S11f 又删掉 5 条零消费导出（`subagentTierTarget`、`supportsSubagentTierRouting`、`routeChildModel`、`SubagentModelSelectionInput`、`DelegateAgents`） | `packages/subagents`、`tools/agents` |
| 6 | `./persistence` | `contract`、`historyDriver`、`checkpoint.type` + S7b 收进来的 `memoryHistoryDriver`（E6） | `persistence-idb`、`persistence-sqlite`、`apps/cli` |
| 7 | `./observability` | `types`、`logReader`、`port`、`trace` + S7a 收进来的 `traceCacheTotals`（记债，见 3.5） | `observability-idb`、`observability-sqlite`、`apps/web` |
| 8 | `./skills` | `contracts`、`projectSkills` | `tools/skills` |
| 9 | `./planning` | `planning/types` | `tools/planning` |

D 类 5 条与 E 类 8 条**不进白名单**（E 类按 3.5 逐条处置后消失）。

**为什么 `.` 不吞掉全部**：宿主 barrel 会连着 `runtime/workspaceDialog` 拉进
`@tauri-apps/plugin-dialog`（见 G10）。工具域与能力包走 4–9 就不必被迫经过 Tauri 代码路径。

## 5. 迁移策略：两步走（不是二选一）

**barrel 收口 vs exports 白名单不是替代关系**——[`vite.config.ts`](../vite.config.ts) 的
`'@einfach-agent/core': .../packages/agent-core/src` 与 [`tsconfig.app.json`](../tsconfig.app.json)
的 `"@einfach-agent/core/*"` 把 `exports` 整个短路了（G5 已述："`exports` 字段在仓库内从未被真正
走通过"）。只改 `exports` 不改源码，仓库内测不出来，发出去才炸。

- **步骤 1（0.1.0 之前必须完成，仓库内非 breaking）**：新建 9 个 barrel，**保留** `./*` 通配，
  用 codemod 把 68 条深导入改写到 9 条，`check-boundaries.js` 加一条"白名单外的
  `@einfach-agent/core/` 深导入 = fail"。此时旧路径仍能解析，回滚成本为零。
- **步骤 2（发 0.1.0 当次）**：删 `./*`，写 9 条显式映射（构建后按 G5 指向带 `.js` 的产物），
  同步收窄 vite alias 与 tsconfig paths。

⚠️ **步骤 2 的验证陷阱**：alias 收窄之后仓库内仍然走 alias，**永远验证不到 `exports` 本身**。
必须额外加一条 Node 原生解析冒烟（对 `dist/` 逐条 `import()` 白名单 subpath 并断言白名单外
路径抛错），否则步骤 2 等于没做门禁。

## 6. 搭便车的两条清理项

- `packages/subagents/package.json` 声明了 **9 条自有 subpath exports**，仓库内实际只有
  `./archive/replay` 被 `scripts/subagent-replay-lib.test.js` 消费，另外 8 条**零消费方**。
  发包前应一并砍掉，避免刚发布就背上 8 条无人使用的公开承诺。
- `packages/agent-plugin-example` 的 `./react` 无所谓——该包按发包蓝图第 5 节不发布。

## 7. 工作量与拆卡建议

粒度：一卡 ≈ 20 分钟 ≈ 一次 commit（沿用仓库 issue 树约定）。

| 卡 | 内容 | 模型 | 卡数 |
| --- | --- | --- | --- |
| S1 | `./tools` barrel + 七工具域与 `tools/standard` 改写（138 处 import，其中非测试 76，机械） | sonnet | 2 |
| S2 | `./subagents` barrel + `packages/subagents`、`tools/agents` 改写（15 条子路径，需判断哪些属契约） | opus | 2 |
| S3 | `./persistence` + `./observability` barrel + 四个 driver 包改写 | sonnet | 2 |
| S4 | `./skills` + `./planning` barrel + `tools/skills`、`tools/planning` 改写 | sonnet | 1 |
| S5 | 根 barrel `src/index.ts` + `apps/web` 改写（面最大，含 atoms 只读边界判断） | opus | 3 |
| S6 | `apps/cli` 改写 | sonnet | 1 |
| S7 | E 类 8 条逐条处置（补进 barrel 或换等价公开 API） | opus | 2 |
| S8 | D 类 5 条：跨包测试改走白名单入口 | sonnet | 1 |
| S9 | `check-boundaries.js` 加白名单规则 + 其 `.test.js` | sonnet | 1 |
| S10 | 删 `./*`、写 9 条显式 exports、收窄 alias/paths、加 Node 解析冒烟 | opus | 2 |

合计 **17 卡 ≈ 5.7 小时**。S1/S3/S4/S6 彼此无依赖可并行；S5 依赖 S7 的结论；S9 应在 S1–S6
全部落地后开，否则门禁自己先红；S10 必须最后做，且与发包动作同一批次。

## 8. 待拍板

1. 白名单是 9 条还是更少（把 `./skills`、`./planning` 并进 `./tools`，降到 7 条，
   代价是工具域 barrel 变杂）。
2. E4–E7 是"给宿主换正式 API"还是"承认现状、补进根 barrel"——前者更干净但要动 `apps/web`
   与 `apps/cli` 的装配代码，属行为改动，不能混在纯改名的卡里。
3. 步骤 2 是否与首发同批。若拆开，`./*` 会带着 0.1.0 发出去，届时删它就是 breaking change。
