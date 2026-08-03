# 结构优化蓝图(按并发批次)

更新时间:2026-08-03。基线:`feat/agentnew-rewrite` @ `24da126`。
本文任务清单来自一次全仓结构评估(codegraph + 深读),行号为该快照下的锚点,执行时以符号名为准。

## 实施状态

批次 1–7 的 33 项任务均已完成（F2 `d8f6a86`、E5 `a7a61b6`、S6 `e612ab4`、R6 `67c72ca` 与重试防护测试 `a438700`）；R7 的前置提交为 `81509c0`，终拆提交为 `338285f`。

## 调度规则

- **批次内并发,批次间串行**。同一批次内任何两个任务不修改同一个文件,可以放心派给
  并发子任务或独立 worktree。
- **每个任务只做一件事**,能用一句不含"和"的话说清。任务不顺手重构、不扩 scope。
- 除批次 1 的守卫修复外,**所有任务行为不变**:对外 API、持久化格式、UI 文案均不动;
  批次 1 的行为变化即是修复本身。
- 每任务收尾:`codegraph affected -q -d 1 <改动文件>` 挑直接测试跑一遍,再 `pnpm build`。
  新文件遵守 one-file-one-thing(普通 ≤300 行,单一算法核心 ≤500 行)。
- 每任务一个 commit,commit message 引用任务号(如 `refactor(core): R2 解环去重`)。

## 任务轨道

按文件簇分轨,保证"同文件每批至多一个任务":

| 轨道 | 文件簇 | 主题 |
| --- | --- | --- |
| R | `runtime/modelRun.ts` + `runtime/core/` | 主循环:守卫、解环、插件接线、拆分 |
| S | `subagents/runtime.ts` 族 | 子 Agent:并发正确性、职责拆分 |
| C | `runtime/commands.ts` | 命令面:去样板、按领域拆分 |
| P | `state/persistence/` | 持久化:契约单源、写队列、core 化 |
| V | `state/subagentViewAtoms.ts` | 视图状态:去重、分层拆分 |
| E | 单例收口(scheduler/planWriters/bridge 等) | 多实例隔离与测试文件并行 |
| F | vendor/平台特化 | DeepSeek/GLM/Tauri 逻辑归位 |
| G | CI 与文档护栏 | 自动化门禁 |

---

## 批次 1 —— 正确性修复与独立护栏(7 任务,已完成)

### R1 · runToolLoop 补齐 stale/abort 守卫
- **只做**:把主循环里遗漏的 runId/status 守卫补到与既有模式一致。
- 文件:`packages/agent-core/src/runtime/modelRun.ts`
- 修复点:
  - `:2667` `patchRun({status:'done'})` 是唯一无 `isRunningRun` 守卫的终态写入(对照 `:2594/:2615/:2677`);
  - `:1264` `await core.projectSkills.ensure(...)`(首次为真 IO)之后,`:1322-1391` 六处 transcript 写入与 `:1453` `ensureToolLoaded` 只有 ghost guard,无 runId 守卫——旧 run 可写入新 run 会话;
  - `:2693-2696` catch 非 abort 分支在 `isRunningRun` 为假时整轮不落盘(含用户消息),与 abort 分支无条件 `commitStoppedTurn()` 不对称;
  - `:2713` `finally` 里 `traceEvent('agent.dispose_failed')` 挂到已 `endSpan` 的 span 上。
- 验收:`modelRun.test.ts` 新增"旧 run 被顶替后不再写入会话"用例;全文件测试绿。

### S1 · root 委派状态改为 per-call 隔离
- **只做**:消除并发 root 委派共享 `ROOT_AGENT_PATH` 桶导致的互相覆盖。
- 文件:`packages/agent-core/src/subagents/runtime.ts`
- 修复点:`:611-613` 三个按 path 分桶的 Map 对所有 root 级委派共用同一 key,
  `:1835/:1856` 后写覆盖先写的档位与危险工具授权,而 `toolContext.ts:545-568` 的
  `spawnAgents` 使前后台并发 root 调用结构上成立;同时统一口径——`:1790-1800`
  rootBudget/semaphore 被首次调用锁死,档位却每次重设。改为按 `delegationCallId`
  (或 per-call 作用域对象)隔离。
- 验收:`runtime.test.ts` 新增"两个并发 root 委派授权互不串台"用例。

### C1 · commands 抽三个内部 helper(不拆文件)
- **只做**:消除逐字重复样板,行为不变。
- 文件:`packages/agent-core/src/runtime/commands.ts`
- 内容:`resolveApiKey(meta, core)`(6 处逐字三元,`:451/:469/:528/:665/:718/:773`,
  统一 `meta.`/`meta?.` 口径);`withRun(...)`(7 处 beginRun→循环→finally endRun);
  `assertRunStatus(...)`(9 处散落的 run 状态白名单校验收成单点)。
- 验收:`commands.test.ts` 全绿,无行为 diff。

### P1 · 持久化契约单源
- **只做**:`SessionsPersistence` / `HistoryDriver` 收敛为唯一定义。
- 文件:新建 `state/persistence/contract.ts`;改 `sqliteDriver.ts:156-169`、
  `persistenceBridge.ts:21-26` 的复制定义为 import(注意 bridge 那份把
  `saveWorkspaces/loadWorkspaces` 标可选与另两份不一致——以真实现为准统一)。
- 验收:类型门禁 `pnpm build`;persistence 相关测试绿。

### V1 · request-token 竞态防护抽 helper
- **只做**:4 份逐字同构的 token 递增+比对代码收成一个 `createLatestOnlyLoader`。
- 文件:`packages/agent-core/src/state/subagentViewAtoms.ts`
  (4 处:`:578/:719/:769/:847` 四个 load atom 及其私有 token atom)。
- 验收:subagentViewAtoms 相关测试绿。

### G1 · CI 门禁落地
- **只做**:让回归自动挡住(ROADMAP 阶段 0 的 P0 项,当前无任何 workflow)。
- 文件:新建 `.github/workflows/ci.yml`:`pnpm install` → `pnpm test` → `pnpm build`
  → `cargo test --manifest-path apps/desktop/Cargo.toml`。
- 验收:CI 在 PR 上真实跑绿一次。

### D1 · UI 边界口径修正(纯文档)
- **只做**:消除 CLAUDE.md 与代码的矛盾陈述。
- 现状:CLAUDE.md 规定"UI 只读 atom、调 commands",但 `SubagentTreePanel.tsx`
  直接 `useSetAtom` 十余个 core 业务 writer atom。
- 内容:在 CLAUDE.md 标注过渡例外清单与目标(批次 4 的 C4 完成命令面包装后收口),
  避免后续贡献者以为 writer atom 直连是认可范式。
- 验收:文档评审通过。

---

## 批次 2 —— 解环与机械去重(6 任务,已完成)

### R2 · 解 `pluginApi → commands → modelRun` 环,删除全部逐字复制
- **只做**:新建无反向依赖的叶子模块,把复制改成 import。这是后续所有插件接线的前置。
- 文件:新建 `runtime/shared/{runGuards,preview,hash}.ts`;改
  `modelRun.ts` / `modelTurn.ts` / `toolContext.ts` / `core/coreCtx.ts` /
  `contextCompaction.ts` / `core/plugins/*.ts` 的 import。
- 收敛清单(均为逐字或近逐字复制):`isCurrentRun` ×3(三种签名,统一)、
  `tracePreview` ×2、`assistantItemFromMessage` ×2、`stringForStats` ×3、FNV-1a ×3。
- 验收:`grep` 确认仓库内每个 helper 仅剩一处定义;全量 `pnpm test` + `pnpm build`。

### S2 · 归档 IO 拆出
- **只做**:`runtime.ts:987-1170` 的 8 个归档函数搬到 `subagents/archiveIO.ts`。
- 验收:`runtime.test.ts` 绿;新文件 ≤300 行。

### C2 · commands 拆分第一刀:workspace + session CRUD
- **只做**:`:172-402` 拆成 `runtime/commands/{workspaceCommands,sessionCommands}.ts`,
  `commands.ts` 聚合再导出,对外 import 路径不变。
- 验收:`commands.test.ts` 绿;全仓无 import 断裂(`pnpm build`)。

### P2 · 写队列统一
- **只做**:`persistenceBridge.ts` 三套并发控制(`:89-190` 合并式覆盖+世代号、
  `:193-251` promise 尾链、`:254-325` per-session 尾链+深度计数)抽成一个
  `createWriteQueue`,并让 `persistTruncate`/`persistDeleteSession`(`:328-335`,
  当前完全不排队、可与在队写交错)进队。顺手把 `sqliteDriver.ts:343/:411` 两处
  模板串拼 SQL 改为 `$n` 参数绑定(同文件小改,不单列)。
- 验收:bridge 测试绿 + 新增"truncate 与在队写交错"用例。

### V2 · 视图状态拆层:IO 与 JSONL 解析出走
- **只做**:`subagentViewAtoms.ts` 的文件 IO(`:544-567/:671-717`)拆到
  `state/subagentArchiveReader.ts`;手写 JSONL 解析(`:469-530/:796-845`)与
  `replay.ts:216-296` 的既有解析收敛为单源 `subagents/jsonl.ts`。
- 验收:相关测试绿;`state/` 目录不再直接读磁盘。

### G2 · 文档链接与旧路径检查
- **只做**:CI 增加 Markdown 相对链接校验和旧源码路径(`src/agentNew/runtime` 等)
  引用检查(ROADMAP 阶段 0 的另一半)。
- 文件:`.github/workflows/` 与脚本,新增文件,不碰 G1 已建 workflow 之外的代码。
- 验收:故意放一个坏链接能被 CI 挡住,随后移除。

---

## 批次 3 —— 契约单源与样板合一(5 任务,已完成)

### R3 · turnEnd 契约单源化
- **只做**:消除 loop 与插件之间"两份谓词靠注释对齐"。
- 文件:`modelRun.ts` + `core/plugins/finishReasonPlugin.ts` + `core/loopHooks.ts`
- 内容:`abnormalFinish` 判据(`modelRun.ts:2041-2044` vs `finishReasonPlugin.ts:155-160`)
  单源;`decision.runStatus` 两处不同处理(`:2078` 忽略 vs `:2093` 尊重)统一;
  `'agent.loop_detected'` 硬编码 fallback(`:2085-2094`)消除——decision 必带
  `traceEventName`;`TurnEndEvent` 交叉类型 + 双侧 `as` 断言(`:2065`、
  `loopGuardPlugin.ts:214`、`finishReasonPlugin.ts:198`)改为类型可表达的扩展协议。
- 验收:三个插件测试 + `modelRun.test.ts` 绿。

### S4 · prompt 组装与模型路由覆盖拆出
- **只做**:`runtime.ts:432-516`(prompt 组装)与 `:518-560` + 升档重试
  (`:1285-1317`)拆到 `subagents/{prompt,modelSelection}.ts`。
- 验收:`runtime.test.ts` 绿;新文件各 ≤300 行。

### C3 · 暂停恢复样板合一 + run 生命周期命令拆出
- **只做**:`resumeWithAnswers`/`confirmTool`/`approvePlan` 三份近同构实现
  (`:629-670/:678-748/:753-776`,`confirmTool` 内部两分支还自我重复一遍)共用一个
  `resumePausedRun` helper;run 生命周期命令拆到 `runtime/commands/runCommands.ts`。
- 验收:`commands.test.ts` 绿,暂停→恢复三条路径行为无 diff。

### V3 · 视图 atoms 收口
- **只做**:类型定义(10 个 interface)拆到 `subagentViewTypes.ts`,
  `subagentViewAtoms.ts` 只剩派生 + 命令 atom,目标 ≤300 行。
- 验收:相关测试绿;`pnpm build`。

### E1 · subagentScheduler 收进 CoreInstance
- **只做**:`subagents/scheduler.ts:190` 进程级单例改为 core 持有,
  旧导出代理 `defaultCore`(与 ROADMAP 阶段 1 的兼容层口径一致)。
- 文件:`scheduler.ts` + `core/coreInstance.ts`。
- 验收:`isolation.test.ts` 待收口清单划掉一项;scheduler 测试绿。

---

## 批次 4 —— 观测成本、命令面收口与单例第一刀(4 任务,已完成)

### R4 · 观测负载惰性求值
- **只做**:观测关闭时不再每轮全量序列化。
- 文件:`observability/trace.ts` + `modelRun.ts` 调用点。
- 内容:`trace.ts:53-57` `enqueue` 在无 driver 时 attrs 已求值——支持 thunk 形态;
  `modelRun.ts:1864/:1924` 的 80,000 字符 request/response preview 改为惰性;
  评估 `buildContextStatsSnapshot` 与压缩估算两条全量 `JSON.stringify` 路径可否共享。
- 验收:观测关闭下的基准(手测长会话一轮耗时)无回退;trace 测试绿。

### S3 · 子 Agent 侧的第二份文案表与并发原语收敛
- **只做**:`runtime.ts:130-151` 平行维护的 finish_reason 文案表改用 R3(批次 3)
  产出的单源;`ModelCallSemaphore`(`:228-270`)与 `runWithConcurrency`(`:562-581`)
  两套手写并发原语合一并移到独立小模块。
- 验收:`runtime.test.ts` 绿。

### C4 · 剩余命令拆出 + UI writer atom 经命令面
- **只做**:plan 审批/checkpoint/UI 卡片命令拆到对应文件,`commands.ts` 收口为
  聚合导出(≤150 行);`SubagentTreePanel.tsx` 直连的业务 writer atom 改走命令面,
  关闭 D1 标注的过渡例外。
- 文件:`runtime/commands/` + `apps/web/src/agentNew/ui/SubagentTreePanel.tsx`。
- 验收:`commands.test.ts` + UI 组件测试绿;CLAUDE.md 例外清单删除。

### P3 · persistenceBridge core 化
- **只做**:`persistenceBridge.ts:32-41` 八个模块级 `let` 与 `:11` 直接
  `import { rootStore }` 改为 bridge 实例挂在 `CoreInstance` 上——修复
  "非默认 core 的 `commitTurn` 把 defaultCore 会话快照落盘"这一错误数据落盘路径。
- 验收:新增"两个 core 各自落盘互不污染"用例;`isolation.test.ts` 再划一项。

---

## 批次 5 —— 状态编码、闸门单源与单例扫尾(6 任务,已完成)

### R5 · checkpoint label 状态结构化
- **只做**:`'[执行中] '` 前缀(`:1178`,`startsWith` 反解于 `:1186/:1209/:907`)与
  `FINISH_REASON_LABEL_TAGS`(`:201-205`)从"中文 UI 串编码状态"改为 checkpoint
  结构化字段(如 `kind`),读侧兼容存量旧 label。
- 验收:新旧 checkpoint 混存下恢复判定正确的用例;`modelRun.test.ts` 绿。

### S5 · 工具闸门抽单源,子 Agent 侧先切换
- **只做**:以主循环语义为准新建 shared 的 `toolGates.ts`,`runChildAgent` 六段
  闸门(`:1529/:1577/:1599/:1618/:1671/:1735`,注释自认"与主循环逐条对齐")改用它。
  **本任务不改 `modelRun.ts`**(与 R5 同批不冲突);主循环切换到同一单源放在 R7,
  在那之前 toolGates 与主循环内联版短暂共存,由 R7 收口。依赖 R2/R3 完成。
- 验收:`runtime.test.ts` 全绿;toolGates 新增 colocated 测试。

### E2 · planWriters 显式穿 core
- **只做**:`state/planWriters.ts:11-14` 模块级 store 改为显式收 core 参数,
  关闭原 `commands.ts:751-752` 自注的"approvePlan 计划态漂到 defaultCore"缺口
  (调用点此时已在 C4 拆出的 plan 命令文件中)。
- 验收:planning 相关测试绿;`isolation.test.ts` 再划一项。

### E3 · archiveWriter 跨实例路径锁 core 化
- **只做**:`subagents/archiveWriter.ts:19` `sharedPathTails`(自注 process-wide)
  改为按 core 实例隔离。
- 验收:archiveWriter 测试绿。

### E4 · execution 持久化判等移除
- **只做**:`execution/runtime.ts:109` `if (core === defaultCore) persistSessions()`
  的身份硬编码改为经 core 自己的 bridge(依赖 P3),隔离实例执行图不再静默丢失。
- 验收:隔离实例执行图落盘用例。

### F2 · vendor 描述表机制化
- **只做**:散落的 vendor 硬编码收进 `agent-ai` 的单一 vendor 描述表:
  `compactionPlugin.ts:77-107` 的 20 个模型名窗口映射、`modelTurn.ts:113-115`
  按 DeepSeek 定死的 `MAX_TURN_TOOLS = 128`;`contextCompaction.ts:56-70`
  `REPLAY_UNSAFE_TOOLS` 手工清单改由工具注册元数据声明(`replayUnsafe: true`),
  消灭"新增工具记得同步这张表"。
- 文件:`packages/agent-ai/` + `compactionPlugin.ts` + `modelTurn.ts` +
  `tools/` 各域注册处。
- 验收:相关测试绿;`grep` 确认 core 内无模型名字面量表。

---

## 批次 6 —— vendor 下沉与终拆(4 任务,已完成)

### R6 · DeepSeek 重试循环下沉 agent-ai（已完成：`67c72ca`、`a438700`）
- 完成形态：`deepseek.ts` adapter 持有 `insufficient_system_resource` 重试和 `user_id` 注入，通用主循环不含 DeepSeek 私有分支。
- 验收：`deepseek.retry.test.ts` 覆盖重试防护；`modelRun.ts` 内无 DeepSeek 引用。

### S6 · subagents/runtime.ts 终拆（已完成：`e612ab4`）
- 完成形态：`runtime.ts` 仅保留 facade；单体循环在 `childAgentLoop.ts`，批次编排在 `delegationBatch.ts`，工具调用、模型客户端、策略和状态各自成文件（均 ≤500 行）。
- 验收：`runtime.test.ts` 全绿；`wc -l` 达标。

### E5 · 开启 fileParallelism（已完成：`a7a61b6`）
- 完成形态：移除全局串行；Vitest 保持文件并行并设置 `isolate: true`，setup 只在 worker 内重置兼容 `defaultCore` 的 store。
- 验收：`pnpm test` 并行稳定通过 3 次。

### G3 · 文档对齐收尾（已完成：`01100e7`）
- **只做**:CLAUDE.md / `docs/README.md` / ROADMAP 与新结构对齐,本蓝图状态更新。
- 验收:G2 的链接检查绿。

---

## 批次 7 —— 主循环终拆(串行,1 任务,已完成)

### R7 · modelRun.ts 拆到 ≤500（已完成：前置 `81509c0`；终拆 `338285f`）
- 完成形态：`modelRun.ts` 成为稳定导出 facade；主循环由 `runToolLoop.ts` 协调，
  lifecycle、bootstrap、循环周期、checkpoint、模型请求和工具执行各自独立成模块。
- 验收：`modelRun.test.ts` 回归安全网保持通过；`modelRun.ts` 仅 14 行，所有新增运行时
  模块均符合单一职责与行数约束，对外符号保持稳定。

---

## 明确不在本计划内(需单独立项)

- **子 Agent 树单一事实源**:节点状态 5 副本、`subagentViewAtoms.ts:374-425`
  启发式对账器的退役,依赖"执行图为唯一源、对话 tool result 只存引用"的持久化
  格式设计,影响存量归档兼容,需要独立蓝图先行。
- **API Key 移出前端构建产物**:ROADMAP 阶段 3 安全项,涉及 Tauri 后端凭证存储,
  与本计划正交。
- **插件注册面产品化**(`prepareRequest`/`beforeToolCall` 等 4 个零消费 hook 槽的
  真实接线):R2/R3 解环后才有意义,按 ROADMAP 阶段 2 推进;在那之前**不新增**
  只有测试消费的注册面。
