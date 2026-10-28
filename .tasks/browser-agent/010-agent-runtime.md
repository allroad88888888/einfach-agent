---
id: '010'
title: 多 Agent 配置可独立持久化并驱动无视图运行
kind: leaf
parent: browser-agent
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-18
done: 2026-09-18
base: 953ae7a118eb974e3bb6d134ef65d6fb23c5082e
files:
  - browser-agent/agent/**
  - browser-agent/README.md
  - browser-agent/extension/package.json
  - browser-agent/extension/tsconfig*.json
  - browser-agent/extension/tsup.config.ts
  - packages/agent-core/**
  - packages/agent-ai/**
  - packages/persistence-idb/**
  - tools/skills/**
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - package.json
  - tsconfig*.json
  - vite.config.ts
  - scripts/check-boundaries*
  - scripts/check-dist*
  - scripts/state-invariants/**
  - docs/core-public-surface-audit.md
  - docs/launch/comparison.md
---

# 多 Agent 配置可独立持久化并驱动无视图运行

## 目标与交付边界

交付一个不依赖界面的 `@einfach-agent/browser-agent` 包，把 Agent、Skill、模型连接/API key、会话创建与
已有 core 装配放在同一包。包括真实可运行的配置 CRUD、IndexedDB 往返、必要 core 接缝、测试与包说明。
本叶是下游 UI、扩展、客户嵌入的共同消费者边界，不拆出额外 host/profile/sdk 包。
files 中既有引擎路径只允许为本包实际用例补接缝与回归，不启动全仓隔离重构。

## 上下文

- 先读 index 的已核实基础；`createCore(opts)` 返回隔离 CoreInstance 与实例命令，未传 registerTools 时没有业务工具。
- `runtime/commands/sessionCommands.ts` 的部分 persist 调用未带 core；不能假设已有实例创建等于所有持久化路径隔离。
- `runtime/commands/runLifecycleCommands.ts` 的 send/stop、相关 pending approval 命令使用 activeSession。
  需显式 sessionId，不允许先 selectSession 再调用模拟隔离。
- `state/core.type.ts` 的 SessionMeta 已有 settings/capabilityPolicy；新增会话配置必须走现有 codec、hydrate、writer。
  `runtime/modelTurnPrefix.ts` 读全局 customInstructions；会话快照需在真实模型请求与恢复路径生效。
- `skills/contracts.ts` 的 SkillsRegistry 现在只 list/buildManifestText；`tools/skills/src/registry.ts` 持有静态正文。
  必须打通注入 Skill 的搜索、正文及资源读取，不能仅在 UI 中显示 Skill 名称。
- `apps/web/src/settings/modelConnectionProfileHost.ts` 可参考配置语义；其 commands 与
  `apps/web/src/modelTransport/openAiCompatRegistry.ts` 的全局状态不能复制或跨包导入。
- `packages/agent-ai/src/providerLocalTransport.ts` 提供 `createProviderTransportFetch`；利用实例 transport/连接解析复用协议，
  不创建第二套模型客户端，不把相同 vendor 下的不同 endpoint 混在一起。
- `packages/persistence-idb/src/index.ts` 三种 driver 可配置 DB 名称；sessions 保存是全量写，namespace 必须有写拥有者。

## 覆盖矩阵行

C01、C02、C03、C04、C14。050/060 会跨表面复核，但本任务必须先独立证明这些能力。

## 消费与产出

- 消费现有 `createCore`、`ToolRegistry.register(tool)`、会话 allowlist、持久化 driver、history/compaction。
- 产出 index 中全部 `BrowserAgentClient`、配置类型和 `createBrowserAgent(options)`，从包根正式 export。
- 产出 index 列明精确签名的显式会话命令；answerQuestion 与内部 undo→stop 链路也传递同一个 ID。
  旧调用仍读 activeSession；非法显式 ID 拒绝而非回退。报告给出完整调用示例。
- 新会话保存 Agent revision、instructions、模型配置/连接身份、Skill 正文资源版本；同一会话后续轮次和恢复不重新读取最新配置。
  原有 capabilityPolicy 仍执行工具与 Skill 限制；不要用 names 快照冒充内容版本冻结。
- 为 020/030/040 准备各包 manifest、tsconfig、tsup、空公开入口及已有依赖引用；不写它们的功能实现。
  workspace 新增 `browser-agent/*` 与 `browser-agent/tools/*`，仅注册真实 package.json。
- 边界、state、dist 扫描包含新根目录及嵌套工具包；为新根违规导入/写入补负例。多入口共享状态的构建保持 splitting。

## 行为要求

1. 创建/编辑/删除 Agent、Skill、连接；校验重复名称、非法 URL、缺失引用、空字段。删除配置不删除已有会话。
2. 初版模型连接支持 openai-compatible HTTP endpoint；已在 AI 包支持的其他协议按现有能力复用，不自造自动探测框架。
   同厂商两个连接必须同时工作，错误要有连接身份且不含凭据。
3. key 写入后只返回 configured 状态；普通配置快照不得带 key。创建工厂和 UI 无隐式真实网络调用。
4. 配置写入失败不发布成功快照；加载损坏/未来版本不静默覆盖。dispose 停止本实例运行并释放订阅、持久化资源。
5. 两个 namespace 的两个 client 可并存。相同 namespace 重复写拥有者明确拒绝或受协调；不要互相覆盖 sessions。
6. 冻结 Skill 内容仍遵守会话/宿主权限上界；删除配置后老会话保留已绑定正文；删除凭据后旧会话明确报告缺连接。
7. 工厂装配本产品所需的 skills/协议控制工具，不调用全量 registerStandardTools 装入 shell、文件系统或 Node 工具；
   页面/API 工具通过 registerTools 接入，core 无 page/api 专有能力字段。

## 验收标准

1. 新增 `browser-agent/agent/src/*.integration.test.ts` 场景：两个 client、三个 Agent、同厂商两 endpoint，
   mock fetch 捕获最终 prompt/模型/工具目录/headers，确认无串配置；断言 public snapshot 无 key。
2. IndexedDB 重建 client 后 Agent/Skill/连接与已有会话恢复；编辑 Skill/instructions 后老会话正文不漂移，新会话使用新版。
   同一连接编辑 endpoint 与轮换 key 分别验证：旧会话仍绑定原目标但使用最新 key。
   故障 driver、重复 namespace、删除被引用配置都覆盖具体预期。
3. 显式发送 A 时切换 UI 到 B，A 的请求、停止、确认与恢复仍归 A；另一个 client 不受影响。
4. 对 `compact_context` 中断恢复与会话能力原有回归运行相关测试；不能把所有 outcomeUnknown 一律清掉。
5. `pnpm exec vitest run browser-agent/agent tools/skills packages/agent-core/src/runtime/commands packages/agent-core/src/runtime/compactMainContext.recovery.test.ts packages/agent-core/src/runtime/modelTurnRequester.compactionTiming.test.ts`
   通过；最终 mock 请求必须覆盖新配置实际影响运行，而非仅断言配置对象保存。
6. `pnpm --filter @einfach-agent/browser-agent build`、`pnpm check:state`、`pnpm check:boundaries` 通过；
   打包后 headless import 不要求 React、DOM 初始化或 Chrome，全量 dist 门在所有包实现后由 060 复核。
7. 报告列出修改过的 core 公共出口、schema 兼容规则、下游命令精确签名、包配置及测试命令；编排者同步后才能派下游。

## 执行记录

- 2026-09-18：用户确认执行后派发；完成报告写 `reports/010-report.md`，独立审查写 `reports/010-review.md`。
- 范围补充：基线 check-docs 在 docs/launch/comparison.md:111 存在失效的 kimiImageFeature.ts 链接；仅修正该引用到当前代码事实，与本任务必要文档一起验收。
- 首次交付 DONE_WITH_CONCERNS；报告已落盘，含 242 + 63 项测试、包构建与门禁证据；编排者亲验 state 通过。
- 独立审查执行中，scope diff 位于 reports/010-scope.diff，包含新建未跟踪源文件；未标 done，后续任务保持 pending。
- 首轮审查 REJECTED，进入 R1：逐项关闭 reports/010-review.md 的 6 条阻断与验收 1/2/3 缺口。
- R1 编排裁决：还须修正异常关闭后永久 owner 占用（否则 050 重开不可用）、dispose 与进行中配置写的竞态、配置库完整结构校验。
  补真正双 client/三 Agent、切换展示并显式操作 A、故障写不发布成功、立即关闭后会话恢复、配置/Skill 编辑后旧会话恢复的行为测试。
- R1 收敛 lockfile：保留新增 workspace importer，恢复本次无意刷新的既有解析版本；再跑定向测试、包 build 与 pnpm build。
- R1 骨架修正：新 UI/扩展沿用现有 React/ReactDOM 18.3.1，不引入 React 19 或双 React；UI 声明实际消费的 core 依赖。
- R1 装配补漏：新 client 必须仅注册既有 compactContextTool；compactMainContext 要求恰好一个 compact timed tool，不能仅靠默认 core 的旧测试证明新宿主支持压缩。
- 并行交接：page/api 骨架已转交 020/030，010 后续不得修改这两个目录；继续独占根依赖/lockfile，校验时注意区分其他执行任务的暂态错误。

- 2026-09-18：执行者交付 DONE，进入独立审查；尚未标为 done。

## R2 修复

- reports/010-review-r1.md 为 REJECTED。原六项代码阻断已关闭；剩余三项 Important 本轮必须逐条补齐，不能以旧测试总数代替缺失行为。
- 修正配置 decode 对原数组 connection ID / Skill name 的重复校验，补 raw IndexedDB 重复身份失败且 owner 可重试。
- 真正同时创建两个 client、三个不同 Agent（分配至少2+1），捕获 endpoint/model/instructions/tools/header，配置/会话/请求无串；切 active 为 B 后显式操作 A 的 send/stop/confirm/answer/resume/continue/recovery/undo/redo，按真实状态分多个内聚测试。
- 对有副作用/恢复入口使用真实 core/tool/mock model 场景；不靠空状态调用未发生行为来声称通过。明确另一 client 的信号、会话状态和请求未受影响。
- 确定性配置写失败：可靠 mock 包内 saveConfig 或 IDB transaction，mutation reject，snapshot 引用和值不变、listener 不触发；随后成功提交证明队列可继续。
- 保留现有正确接缝，测试可按隔离/命令/持久化分文件；各文件只负责一件事且 <=300 行。完整重跑受本轮影响的定向集与包构建，报告逐项列出新增测试与断言，不再将未执行场景记 DONE。

- 并行交接：R1 复审确认公共命令与契约正确，UI 骨架完整交给 040；010 R2 不再写 browser-agent/ui/**，根依赖仍由 010 独占。

- R2 编排抽查补充：owner获取后 createCore/registerTools/persistence.configure 同样纳入初始化失败清理；宿主 registerTools 抛错后应能同namespace重建，补定向负例。

- R2验收补证据：multiClient lifecycle 当前通过注入runAtom构造running，无真实AbortController运行；在提交R2复审前补一个pending mock fetch的真实运行中stop场景。至少A和另一client C均有活跃请求，切active到B再stop A，断言仅A信号aborted，C/B不受影响，随后settle清理。

- 2026-09-18：R2已补真实pending fetch停止隔离，36文件265测试通过，进入reports/010-review-r2.md复审；根build待UI稳定后统一执行。

- 2026-09-18：R2独立复审PASSED，C01/C02/C03/C04/C14与验收1–7通过，010 done；公共合同不变，根配置/lock与extension骨架交给050。
