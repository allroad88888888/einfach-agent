---
name: project-lines
description: "web-agent — 主线与分支线：东西放哪、数据怎么走、模仿哪个成员、哪些漂移不抄。先读本索引，再只读相关的 1–2 个线文件。2026-08-20 于 commit 1ebe4a0 学得，同日负责人确认 24 条裁决（含一条改变目标形态的方向裁决）。"
---

# web-agent · 线索引

> 由 `learn-project` 于 commit `1ebe4a0`（2026-08-20）学得，同日负责人答复。下面的数字来自
> `mechanical/`，可用 `check.sh` 重算。裁决在各线文件末尾的「裁决」节，逐条注明出处。

## ⚠️ 方向裁决：agent 循环要跑在服务端（2026-08-20，dol）

**所有线文件描述的都是「当前形态」，不是目标形态。**负责人已裁定：**agent 循环跑在服务端，
前端纯展示，tools 与 mcp 的逻辑都在后端。**

当前形态与它相反——core 装在 `apps/web/src/main.tsx`，主循环在**浏览器**里转；`apps/server`
对 core 的依赖只有一个 `import type { HostInvoke }`（`invokeRoute.ts:26`），它只提供能力面与
模型转发；CLI 则在自己进程里装同一份 core，是唯一前后端同进程的形态。

按受影响程度排（迁移时按这个顺序读线文件）：
- **02 宿主分流** —— `static` 态（纯静态无后端）在目标形态下不再能跑 agent，9 个分流点大半会变成后端内部的事。
- **16 MCP** —— 连接编排、清单缓存、占位工具整套迁到后端，前端只留配置界面与状态展示。
- **12 持久化 driver** —— IndexedDB 那套存在的理由是「浏览器自己存」，**可能整条作废**。
- **01 会话状态** —— 三层 store 分工要重画：前端只剩投影，日志与快照都在后端。红线本身不变。
- **15 UI 渲染** —— 反而变重：渲染成为前端唯一职责，registry 与组件形状不变。
- **00 / 10 / 11 / 13 / 17** —— 契约与形状不变，变的是在哪个进程里执行。

这次迁移尚未开始，也没有排期。在它开始之前，线文件仍是当前代码的准确描述。

## 怎么用
- 任务 → 在下表找到线 → 读那个文件（≤200 行）→ 模仿其样板成员、碰其配方文件、不抄其漂移 →
  收尾检查 diff 仍在线上。
- 局部任务不重扫仓库。只有负责人改了设计才改线。
- 本目录**不是** `.claude/skills/`：那个路径整个被 `.gitignore:17` 忽略，且会被本仓库的 project
  skills loader 扫进 L1 清单、占 100 个名额。线文件必须随代码进 git，所以住这里。

## 线

| 文件 | 线 | 类型 | 汇合点 | 状态 |
|---|---|---|---|---|
| `lines/00-主线-run执行链路.md` | 发消息 → 请求组装 → 工具执行 → 落盘 | 主线 | `runToolLoop.ts` 循环编排；`modelTurnPrefix.ts:79-84` 前缀四段 | ✅ 2 条 · 2 条未提交 |
| `lines/01-主线-会话状态与恢复.md` | atom → writer → 事务日志 → 快照 → 恢复 | 主线 | `sessionSlots.ts` 的 `SESSION_SLOTS`（10 槽）；`persistenceBridge.ts` | ✅ 3 条 |
| `lines/02-主线-宿主分流与装配.md` | resolveHost → 桥/传输/凭据/driver | 主线 | `main.tsx:141` 唯一探测点；9 个分流点全收 `host` 形参 | ✅ 3 条 · **方向影响大** |
| `lines/10-分支-工具家族.md` | 33 个工具目录（32 注册 / 31 模型可见） | 分支线 | 各域 `tools/<域>/src/index.ts` registrar；`tools/standard` 一把装齐 | ✅ 4 条 |
| `lines/11-分支-运行时插件.md` | 3 个内建插件 × 7 个 hook 槽 | 分支线 | `defaultPlugins.ts:7-11`（运行时）+ `pluginHost.ts`（安装） | ✅ 2 条 · 1 待确认 |
| `lines/12-分支-持久化与观测driver.md` | idb/sqlite × persistence/observability | 分支线 | `main.tsx:117-125` 两处装配；5 份 core contract | **待方向落地** |
| `lines/13-分支-子agent委派.md` | 委派 → 批次 → 子 run → 归档 | 分支线 | `delegationCapabilities.ts:122` `spawnAgents`；执行图 `agent-batch` 节点 | ✅ 3 条 · 1 待确认 |
| `lines/14-分支-仓库门禁.md` | 5 条门禁 + state-invariants 5 判据 | 分支线 | `ci.yml` 单条 web job 的 9 步里占 5 步 | ✅ 3 条 |
| `lines/15-分支-UI渲染与timeline.md` | item → registry 查表 → 薄适配组件 | 分支线 | `webTimelineRendererRegistry.ts`（6 kind 全锁）；`TimelineItemView.tsx:16` | ✅ 5 条 |
| `lines/16-分支-MCP第七域.md` | 连接 → 清单缓存 → 占位工具 → 远端调用 | 分支线 | `main.tsx:152` + `toolProbeWiring.ts:117`（唯一注册点） | ✅ 3 条 · **方向影响大** |
| `lines/17-分支-模型adapter与skills.md` | provider 私有变换 / skill 三层披露 | 分支线×2 | `builtinProviders.ts:216-219`；`skill-manifest.ts:17` 到点工具 | ✅ 5 条，**建议拆分** |

**17 该拆成两条**（该线自评，给了三条可核对的理由：无 import 边、薄接口形状不同、变更半径零交集）。
未拆是因为拆分要重组内容而非机械切分——等负责人确认后由一次针对性重学完成。

**公共层（不是线）：** `packages/host-node`（唯一一份宿主能力实现，浏览器经 HTTP、CLI 进程内跑同一份
代码）、`packages/agent-react` 的 store 绑定、`runtime/shared/`。它们 fan-in 高但没有可插拔成员家族。

## 追线时发现的结构修正（≥2 条线交叉印证）

1. **压缩已经不是插件了**（00 + 11 独立得出，11 给出提交）。`compactionPlugin` 于 `d1e1c33`
   （2026-08-11，durable context checkpoints）被移出 `defaultPlugins.ts`；今天全仓引用这个**值**的
   只剩它自己的测试。真跑的是 `modelTurnRequester.ts:85-128` 的内联 checkpoint 蒸馏。
   连带：`preCompact`/`postCompact` 两个 callTiming 时机在生产里**没有触发方**，九个核心时机实际只有
   7 个会响；`transformContext` 槽默认无人注册。→ A1、A2。
2. **CLI 是第三条装配路径，不是第三个宿主态**（01 + 02 + 16 独立得出）。它不调 `resolveHost()`，
   并且**没有持久化**（`runtime.ts:9` 悬空 import，`noUnusedLocals` 关着所以不红）、**没有 MCP**、
   trace 只在 `--verbose` 时打 stderr。宿主本身只有 `server` / `static` 两态。→ B1。
3. **skill 的 L1 清单已离开稳定前缀**（00 + 17 独立得出）。改由 `callTiming:'sessionStart'` 的
   `skill_manifest` 工具产出成 timeline item（`a88ba16`），`modelTurnPrefix.test.ts:38` 直接断言前缀
   不再调 `buildManifestText`。两份蓝图与 `modelTurnSystemItems.ts:9-13` 的注释都还是旧说法。→ B3。
4. **Tauri 残留注释是全仓性的**（02 + 10 + 12 + 16 各自撞到）。桌面壳已于 `e52c31d` 整体删除，但
   sqlite 两包、MCP 侧 12 个文件、`health.ts:30/34`、多个工具域的注释仍以它为对照系或判据。
   真实判据一律是 `hasHostBridge()` / 两态 `resolveHost()`。→ E 组。
5. **撤销条在生产里从不显示**（01 + 15 独立得出，同一诊断）。`UndoBar.tsx:24` 裸 `useAtomValue` 读
   会话 atom 工厂 → 依赖全取默认值 → 恒 `return null`。三道防线全漏：规则 5 只认「core 直接导入的
   标识符」（这是工厂函数）、`UndoBar.test.tsx:20` 把会话 store 当界面 store 传（正是
   `renderWithStore.tsx:19-20` 写明要防的掩盖）、TypeScript 无从发现。→ A3、A4。
6. **选 driver 的判据是「这一态有没有 SQL 通路」**（02 + 12 独立核到两处逐字相同的判断）。它与
   「有没有本机能力桥」是两回事；写岔会得到「写进 SQLite、从 IndexedDB 读」，不报错，只让
   TraceViewer 恒空。

### 一处线间冲突（我复核后裁定）
01 线报「CLAUDE.md 仍写 Web=IndexedDB / Tauri=SQLite」，12 线报「CLAUDE.md 已更新为两态」。
复核当前文本（`CLAUDE.md:300-311`）：**12 线对**。过时的是我发给追线 agent 的 CLAUDE.md 引文
（会话开头的缓存版本），不是文档。10 线那条「CLAUDE.md 仍写非 Tauri 环境不暴露 server 工具」同因
撤回。教训写进本索引，是因为它会再次发生：**给子 agent 的文档引文必须现读，不能用会话缓存。**

## 已确认的规则（负责人 ✅，2026-08-20）

新代码必须守的（逐条出处见各线「裁决」节）：
- **每个工具一目录三件套**：实现 + `.md` + 同目录测试，**到点工具也要写 `.md`**；计划域那三个欠的要补。
- **MCP 等动态提供方注册的工具必须打 `origin:'external'`**，否则 `toolRegistry.ts:71-77` 那道保护恒不生效。
- **加工具要同步改 `tools/standard/src/index.ts` 的计数注释**（它算对外说明，不是装饰）。
- **新门禁一律带 `--root` 注入 + fixture 自测**。
- **provider 共形测试覆盖全部四家**（含 `openai-compat`，它是正式第四家，web 侧要补齐传输与凭证面板）。
- **`check:state` 规则 5 要扩判据**，盖住「返回 `Atom` 的 core 工厂」与 `@einfach-agent/subagents` 的会话 atom。
- **重复的判据/类型一律收敛到后端一份**（MCP 失败分类表、`McpTransport` 联合），不靠「加测试保证两份同步」。
- **skill 数量上限 100**（已改），取舍交给启停偏好；启停机制与 `ProjectSkillsPanel.tsx` **已存在**，不要重做。

已确认要做的清理（不是「别模仿」，是真删）：`compactionPlugin` 6 文件 1648 行（**先给
`preCompact`/`postCompact` 补触发路径再删**）、`delegate_agent` 同步返回分支、`SubagentTreePanel`
5 文件、`hostRecoveryFlush.ts`、`pnpm subagent:capacity` 命令、`apps/cli/src/runtime.ts:9` 悬空 import。

已确认要修的 bug：`UndoBar.tsx:24`（撤销条永不显示，测试也要改传 `agentStore`）。

已确认的方向变更：skill 的 L1 清单**最终要迁回请求固定前缀**（现在的 sessionStart 消息是过渡态）；
换模型 escalation 要从 `subagents/` 提到共用层；`PlanStageExecutionTrace` 合并进 `TimelineItemView`；
新 timeline kind 从下一个起留一格不锁。

## 各线各自最要紧的一条（不重复上面的交叉印证）

- **00**：稳定前缀一个 run 只建一次（`toolLoopBootstrap.ts:76`），之后每轮复用；尾巴 controls 最多
  4 条 system、每轮重算。暂停三态全在 `toolCallBatch.ts` 结尾，一批只允许一个暂停。
- **01**：`SESSION_SLOTS` 10 槽 = 增量 5 / 有界整值 5 / snapshotOnly 0；会话 atom 全集 21 个；
  `recoveryProjection.ts` 的 capture/apply 仍是手写字段列表，**新增槽位漏改这两处不报错**。
- **02**：9 个分流点里只有 4 处是 `switch` 穷举（加宿主态会红），另 5 处是 `if`（加态不会红，
  静默走 static）。`/api/*` 四道防线卡在路径分派**之前**，所以路径拼错拿 401 不是 404。
- **10**：33 个工具目录 ≠ 32 个注册工具 ≠ 31 个模型可见（`path-operation` 一目录出两个工具，
  `tools/skills/src/planning/` 不是工具，`skill_manifest` 是到点工具被可见性滤掉）。
- **11**：core 插件与 React 插件是**平行两套**契约（品牌 Symbol、安装面、生命周期都不同），
  只在 manifest 的 `entry.core`/`entry.react` 层碰头，而 loader 只装 core 入口。
- **12**：快照 + 撤销日志成对落盘靠**应用层时序**（`persistenceBridge.ts:161-179`，只在 recovery
  保存成功后才写日志），单驱动内部原子性 IDB 用 readwrite transaction CAS、SQLite 用单条
  `INSERT...ON CONFLICT...WHERE`——两处都刻意不用 BEGIN/COMMIT（连接池会把语句路由到不同连接）。
- **13**：子 run 不写会话 items/run atom、不流式、无插件、不能 pause、末轮强制合成，工具全部借道父
  `ToolContext.runChildTool`。
- **14**：`check-state` 是拆得最开的样板（入口 64 行只装配，5 规则各一模块 + 1 张账表）；每条门禁的
  「漏判会怎样」都能引到具体事故。
- **15**：切会话只清 4 个界面 atom（草稿、图片附件、消息窗口、阶段轨迹窗口），漏清＝A 会话打一半的
  字发进 B；展开态刻意不清（按 id 索引，天然失配）。
- **16**：「加一个 connector」的配方异常干净——一群新文件 + **恰好一个**被改的旧文件
  （`initialize.ts:79`），`tools/mcp/**` 一个都不碰。
- **17**：厂商级重试只有 deepseek 一家；`maxTurnTools` 四家全 128；全仓只有 1 条 `provider-upload`
  图片能力（kimi-k2.6）。

## 机械证据（来自 `mechanical/`，模型没参与）

### 规模
1787 个跟踪文件、647 次提交。顶层：packages 1010 / apps 405 / tools 225 / docs 55 / scripts 45 / evals 22。
`agent-core/src` 分区：runtime 272 / state 69 / subagents 53 / plugins 17 / tools 14 / observability 13 /
skills 10 / execution 6 / planning 5 / timeline 2。

### import 方向
```
   apps →  packages(96)  tools(25)
   evals →  packages(6)
   packages →  tools(15)
   scripts →  packages(3)
   tools →  packages(62)
```

### 家族形状
```
packages/  members=10  core: README.md package.json src/index.ts tsconfig.build.json tsconfig.json tsup.config.ts
tools/     members=8   core: 同上 + src/raw-modules.d.ts
离群：packages/agent-plugin-example（缺 tsup/tsconfig.build，且不在 vite alias 与根 package.json）
      packages/host-node（缺 README.md）；tools/standard（缺 raw-modules.d.ts——其实合规，全包无 ?raw）
```

### 汇合点覆盖
```
packages: vite.config.ts 9/10 · package.json 8/10 · check-boundaries.js 7/10
tools:    vite.config.ts 8/8 · main.tsx 3/8 · cli/runtime.ts 3/8
```
后两行的差集有解：`@einfach-agent/tools` meta 包传递带来六域，两个直引取的是非工具导出
（`createDefaultPlanRuntime`、`builtInSkillsRegistry`）；`tools-mcp` 由 `toolProbeWiring.ts:117` 单独装。

### 提取器没算出来的
`tools/` 家族**没有** recipe——所有「工具出生」提交都 >60 文件。10 线手工从 4 次出生提交取交集：
impl.ts 4/4、test.ts 4/4、域 index.ts 4/4、.md 3/4。

## 文档与代码不一致（只需修，不需裁）
见 `questions.md` 的 E 组（CLAUDE.md 5 条已逐条 grep 复核；另有代码注释群与 docs/ 6 处，
以及 2 条经复核撤回的误报）。

## 待确认（31 条里还剩 7 条）
- **A5 子 agent 续跑**：负责人的意思是「那两个 disposition 是过度设计，真正要的是死循环时能输出原因、
  关掉子 agent 再重开一个」——这个解读待确认，且「关掉再重开」现在有没有尚未核实。
- **A6 外部插件 hook 面**：已定「插件一视同仁」，但 `beforeToolCall` 能返回 `{block:true}` 拦下工具调用，
  给第三方等于让它能否决 shell 命令、改模型看到的上下文——这一半待确认。
- **B1 CLI 定位**：暂定「一次性工具」，方向裁决落地后要重开。
- **B6 idb 先例**：受方向裁决影响（idb 那套可能整体作废），一并再定。
- **D4** `sourceFiles.js` 扫描面含 `dist/`：答「不知道」，保持未决。
- 另有 **6 条**（00-3、00-4、11-3、12-1、14-4、16-4）是我在合并时按 `question-filter` 判为
  「不改变新代码去向」而**未提交**给负责人的，各自记在线文件里，保持未决。

## 学习成本
| 线 | 打开文件数 | tokens |
|---|---|---|
| 00 run 执行链路 | 48 | 181k |
| 01 会话状态与恢复 | 62 | 173k |
| 02 宿主分流与装配 | 49 | 199k |
| 10 工具家族 | 49 | 171k |
| 11 运行时插件 | 42 | 170k |
| 12 持久化与观测 driver | 29 | 153k |
| 13 子 agent 委派 | 66 | 190k |
| 14 仓库门禁 | 32 | 145k |
| 15 UI 渲染与 timeline | 34 | 159k |
| 16 MCP 第七域 | 40 | 230k |
| 17 模型 adapter 与 skills | 58 | 204k |
| **合计** | **509** | **≈1.98M** |

11 条线并行追踪，墙上时间约 11 分钟（最慢一条 669 秒）。机械提取零 token。
之后每个任务读 1–2 个线文件（≤200 行），不重扫仓库。
