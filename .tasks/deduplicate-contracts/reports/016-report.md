# 016 文件职责、测试证据与提交隔离复审

## 结论

**REJECTED**。未发现 Critical，但有 4 个 Important：当前轮边界仍有第二个导出实现；子 Agent 能力枚举仍在续跑/归档协议中重复定义；`invokeRouteBody.ts` 明确承担两个独立职责；workspace 乐观并发 hash 仍有两个同域实现。它们分别违反“单一 owner”或文件单一职责，现有绿测未能防止这些漂移。

审查基线为 `55a3d2e..2eee1e1`。机械扫描该范围内 `apps/**`、`packages/**`、`scripts/**`、`tools/**` 的 168 个变更文件，并从当前文件、diff、引用关系和 13 个提交重新取证；未以既有审查报告代替判断。

## Critical

无。

## Important

### I1. 当前轮起点仍有第二个导出 owner，且无用户项时语义已经分叉

- 新 owner 位于 `packages/agent-core/src/runtime/activeTurnItems.ts:12-25`：接受 `turnId`，锚点缺失时退回最后一条 user，没有 user 时返回 `0`；`currentTurnItems`、recovery 与 tool outcome 都已消费它（同文件 `:34`、`runtime/commands/recoveryCommands.ts:139`、`runtime/toolCallOutcomeFacts.ts:35`）。
- 旧 owner 仍由 `packages/agent-core/src/runtime/commands/turnSafety.ts:6-11` 导出：忽略 `turnId`，没有 user 时返回 `-1`。全仓引用扫描显示它当前没有消费方，但仍是可导入契约。
- 这不是无害别名：两个同名函数对锚点和空 user transcript 给出不同答案。`activeTurnItems.test.ts:13-30` 只证明新实现，没有防止旧导出重新被使用或继续漂移。
- 修复应删除旧导出；`turnSafety.ts` 只保留 side-effect 判据。若确有旧路径兼容需要，也只能 re-export 新 owner，不能留实现。

### I2. delegate 能力集合未真正覆盖恢复与归档协议，新增档位会要求人工同步多处

- 当前声明的唯一集合是 `packages/agent-core/src/subagents/types.ts:11-25` 的 model tier/task category/risk level，以及 `packages/agent-core/src/subagents/toolProfile.ts:9-15` 的 tool profile。
- `packages/agent-core/src/subagents/continuationDescriptor.ts:12-23` 又手写了四组 union；`continuationDescriptorParser.ts:72-85` 又手写了四组数组。恢复 parser 因而不是从公开能力集合派生。
- 本轮新增的 `packages/agent-core/src/subagents/archiveEventPayload.ts:3-4,211-216` 还单独定义并判定 `'flash' | 'pro'`；其 `toolProfile`/`confirmedTools` 也退化为无约束 string（`:20-21`）。
- `tools/agents/src/delegate-agent/delegate-agent.test.ts:69-117` 很好地锁住了 schema/guide 与公开集合，却完全没有把 continuation parser 或 archive decoder 纳入同一矩阵。`continuationDescriptor.test.ts` 也只使用一个固定样本。
- 后果是能力集合扩展时，输入/schema/docs 可以接受新值，而恢复或 archive decode 仍可能拒绝；部分类型不一致会在编译期暴露，但运行时 decoder 的硬编码仍靠人工同步。应让 snapshot/archive 类型引用公共类型，parser/decoder 用公共 readonly 集合判定，并增加遍历全部公开值的 round-trip 测试。

### I3. 大改后的 `invokeRouteBody.ts` 仍明确负责两件互不依赖的事

- 文件头自己列出“两件事、各自独立可测”（`apps/server/src/invokeRouteBody.ts:3-7`）：`hasJsonContentType` 的 CSRF/content-type 判据（`:19-38`）和 invoke JSON 顶层对象投影（`:40-68`）。二者互不调用，分别服务不同 export，直接未通过一句话测试与引用聚类测试。
- `apps/server/src/modelRouteBody.ts:33-38` 为共享 content-type 判据反向 re-export invoke 文件，导致 model route 依赖另一个业务 route 的实现位置；这不是稳定的兼容边界。
- 该文件在 013 中有 76 行 churn，且同一提交已同时修改 `invokeRouteBody.ts`、`modelRouteBody.ts` 并抽出 `boundedJsonBody.ts`，不能按“路过存量小改”豁免。
- 应把 `hasJsonContentType` 与其测试移到按抽象命名的共享模块（例如 `jsonContentType.ts`），两个 route 直接消费；`invokeRouteBody.ts` 只负责 invoke body 投影。

### I4. 同一 host workspace 乐观并发契约仍有两份 `contentSha256` 实现

- 新 owner `packages/host-node/src/workspace/change/contentHash.ts:6-16` 定义格式正则与 `sha256:<lowercase hex>` 计算，write/patch guard 已消费它。
- 既有 `packages/host-node/src/workspace/read/content.ts:31-34` 在同一 package 内保留同名、同格式、同算法的独立实现。该文件 `:12-14` 还明确说明 read 产出的 hash 要供 write 的 `expectedContentHash` 使用，二者属于同一乐观并发协议，不是不同信任边界各自校验。
- 两套测试分别钉公开向量，但没有一条测试证明 read 产物始终被 mutation owner 接受；将来调整前缀、编码或算法仍要人工同步两份生产实现。
- 应只有一个字节级 hash owner；字符串调用方显式 UTF-8 编码后复用它。工具输入层的格式复验可以因信任边界保留，但 host 内的 hash 计算不应双写。

## Minor

### M1. 共享 bounded JSON reader 的 model wrapper 缺直接反漂移用例

`apps/server/src/boundedJsonBody.test.ts:11-50` 覆盖共享 reader，既有 `invokeRouteBody.test.ts` 覆盖 invoke wrapper；但全仓没有直接调用 `readModelRouteBody` 的测试。`modelRouteBody.ts:66-69` 特有的“empty → invalid-json”映射目前只靠代码可见性。建议补一个很小的 wrapper 用例，避免以后共享 reader 的 `empty` 语义被原样泄漏到 model endpoint。

### M2. server 包边界守卫未识别 CommonJS runtime require

`apps/server/src/packageBoundary.test.ts:51-74` 识别 ESM import/export 与动态 `import()`，但不识别 `require('@einfach-agent/...')` 或 TS `import = require(...)`。当前 server 源码是 ESM 且未发现此类调用，所以不阻断；若这条测试声称覆盖“运行时 workspace import 均声明依赖”，建议补 AST 分支或明确约束只允许 ESM import。

## 文件行数审计

### 所有 >300 的变更文件

| 当前行数 | 基线行数 | 文件 | 判定 |
|---:|---:|---|---|
| 872 | 872 | `packages/agent-core/src/runtime/modelTurn.test.ts` | 不具备复杂算法/状态机例外资格；本轮仅等量改 20 行测试，属存量超限小改，按规则指出但不要求 013 顺手拆。 |
| 376 | 372 | `packages/agent-core/src/subagents/runtime.budgetAndConcurrency.test.ts` | 测试文件不豁免；本轮只增加 4 行断言，属存量超限小改，按规则指出。 |

除此之外，168 个变更文件当前均不超过 300 行；没有需要援引“复杂文件 ≤500”例外的新文件。本轮触及且接近上限的存量源码包括 `delegationBatch.ts` 300 行、`dangerousTools.ts` 297 行、`find-test-lint-commands.ts` 297 行，均未越线。

### 新增/大改源码逐一职责判定

下表覆盖全部新增生产模块，以及 churn ≥40 的既有生产模块；物理行数均为当前 `wc -l`。

| 文件（行数） | 一句话职责判定 |
|---|---|
| `apps/server/src/boundedJsonBody.ts` (65) | 有界读取并解析 Node JSON body；通过。 |
| `packages/agent-ai/src/providerOrigins.ts` (5) | 定义官方 provider origins；通过。 |
| `packages/agent-core/src/runtime/planPersistence.ts` (77) | 提供计划写入的 recovery durability barrier；通过。 |
| `packages/agent-core/src/state/modelSettingsSchema.ts` (77) | 定义并校验 ModelSettings schema；通过。 |
| `packages/agent-core/src/subagents/archiveEventPayload.ts` (234) | 编解码版本化 child archive payload；文件内聚，但能力值仍有 I2 的第二 owner。 |
| `packages/agent-core/src/tools/toolResultModelPayload.ts` (19) | 序列化模型可见 ToolResult；通过。 |
| `packages/host-node/src/rollout/historyTargetSql.ts` (47) | 在 history target 与 SQL identity 之间映射；通过。 |
| `packages/host-node/src/workspace/change/contentHash.ts` (16) | 定义 mutation content-hash 原语；自身内聚，但唯一性被 I4 否决。 |
| `packages/host-node/src/workspace/change/decodeWorkspaceChangeContext.ts` (35) | 解码 mutation change context；通过。 |
| `packages/host-node/src/workspace/common/pathExists.ts` (13) | 提供跟随软链的存在性探针；通过。 |
| `packages/observability-idb/src/indexedDbLogDatabase.ts` (33) | 打开 observability IndexedDB schema；通过。 |
| `packages/persistence-idb/src/indexedDbTransaction.ts` (43) | 统一单 store transaction 结算；通过。 |
| `scripts/subagent-archive-paths.js` (30) | 映射并约束 archive CLI run path；通过。 |
| `tools/fs/src/workspaceResultEnvelope.ts` (33) | 兼容 workspace runtime envelope 与旧直接结果；通过。 |
| `tools/shell/src/shellCommandTool.ts` (130) | 构造平台参数化 shell command tool；通过。 |
| `packages/agent-ai/src/providerTransport.ts` (249) | 定义环境无关 provider transport contract；虽包含类型、限额和 route policy，但它们共同构成一个对外协议，未越线，通过。 |
| `packages/agent-core/src/history/agentHistoryTarget.ts` (105) | 定义、解码并规范化 history target identity；通过。 |
| `apps/cli/src/credentials.ts` (147) | 装配 CLI 模型凭据来源；通过。 |
| `apps/web/src/modelTransport/providerRoute.ts` (116) | 在 Web 请求 URL 与共享 provider target 间映射；通过。 |
| `packages/host-node/src/model/providerRouteCatalog.ts` (32) | 把共享 route policy 投影为 host origin binding；通过。 |
| `scripts/model-preview-relay-routes.ts` (93) | 把共享官方 route policy投影为 preview relay route；通过。 |
| `packages/agent-core/src/runtime/commands/planCommands.ts` (111) | 实现计划审批与阶段回退命令族；作为同一 plan command facade 可接受。 |
| `packages/host-node/src/model/requestBody.ts` (208) | 收窄并准备 provider wire body；通过。 |
| `apps/server/src/invokeRouteBody.ts` (68) | 失败：同时拥有 content-type 安全判据与 invoke body 投影，见 I3。 |
| `apps/server/src/modelRouteBody.ts` (70) | 投影 model endpoint JSON body；主体通过，但不应承载 I3 的跨业务 re-export。 |
| `packages/subagents/src/archive/replay.ts` (248) | 从 archive event stream 重建 replay state；单一 replay 状态机，≤300，通过。 |
| `packages/persistence-sqlite/src/sqliteRecoveryDriver.ts` (142) | 实现 SQLite recovery persistence/facade；读 facade 与 driver 共用 row codec，内聚且未越线。 |
| `packages/observability-idb/src/indexedDbLogDriver.ts` (42) | 写 observability log store；通过。 |
| `packages/observability-idb/src/indexedDbLogReader.ts` (45) | 读 observability log stores；通过。 |
| `packages/agent-core/src/subagents/types.ts` (272) | 定义 subagent domain contract；本轮新增集合内聚，但续跑/归档消费者未收敛，见 I2。 |
| `packages/agent-core/src/subagents/input.ts` (242) | 规范化 delegate_agent input；单一解析流程，≤300，通过。 |
| `tools/shell/src/shell-linux/shell-linux.ts` / `shell-macos.ts` / `shell-powershell.ts` (各 11) | 各自只声明一个平台 descriptor；真实共享执行在 `shellCommandTool.ts`，不是假拆分。 |

其余新增文件均为对应模块的测试，最长 `tools/shell/src/shellCommandTool.test.ts` 132 行；没有新增测试文件越线。

## 共享 owner、兼容导出与测试证据

- provider policy：host catalog 直接由 `PROVIDER_ROUTE_POLICIES` 映射，Web/host/relay 的全表对拍位于 `scripts/model-preview-relay-routes.test.ts:91-117`；官方 origin 字面量只在 `providerOrigins.ts` 出现。通过。
- history target：core shape/decoder/schema 唯一位于 `agentHistoryTarget.ts`，host SQL 仅做列映射，tool schema 调用 `agentHistoryTargetJsonSchema`。通过。
- plan persistence：四个消费面都调用 `createPlanPersistenceAdapter`/`blockPlanPersistence`，定向错误/非 saved/rollback fallback 测试完整。通过。
- shell：三个平台文件仅保留 descriptor；`shellCommandTool.test.ts:50-131` 用 `describe.each` 对三个平台执行同一契约。通过。
- archive result：producer 使用 `createChildFinishedArchivePayload`，replay 使用 decoder；`runtime.archiveReplay.test.ts:7-43` 提供真实 producer→replay 的非空 change set 证据。payload 内的能力枚举仍受 I2 影响。
- 兼容导出：`core.type.ts:13`、provider adapter 的 origin re-export、`commandPayloads.ts:22,32` 的类型别名、`persistence-sqlite/src/index.ts:4` 均只转发 owner，没有重写实现。`modelRouteBody.ts:38` 的跨业务 re-export 是 I3 的例外问题。
- workspace mutation：change context 与 patch operation 类型已由 core/host 各自单点消费；hash 计算仍受 I4 影响。

## 提交隔离

`git log --reverse 55a3d2e..2eee1e1` 恰有 13 个提交：12 个原编号实现提交与 1 个 server follow-up；没有 squash 或缺号。

| 提交 | 归属 | 隔离判定 |
|---|---|---|
| `97a92e9` | 002 CLI model config | 独立。 |
| `17113d9` | 004 archive paths | 独立。 |
| `7939d09` | 006 current-turn boundary | 提交范围独立，但留下 I1。 |
| `4b911d1` | 001 archive result payload | 独立。 |
| `558de25` | 007 plan persistence | 独立。 |
| `d2104e3` | 003 provider transport policy | 独立，manifest/lock 属运行时依赖接线。 |
| `2d0fe21` | 008 delegate contract | 独立，但留下 I2。 |
| `f8605fe` | 009 workspace mutation contract | 独立，但新增 I4 的第二同域 hash owner。 |
| `c6182c5` | 012 shell execution | 独立。 |
| `9316692` | 005 history contract | 独立。 |
| `82431a4` | 011 recovery facade | 独立，manifest/lock 属依赖接线。 |
| `67de8f5` | 013 domain primitives | 按 index 的明确裁决跨领域但仍为原编号单 commit；包含 I3。 |
| `2eee1e1` | server package follow-up | 只含 server manifest、tsup config、边界测试与 lockfile；独立。 |

产品文件跨提交重叠仅有 5 处：`modelRouteBody.ts`（003→013）、`childResult.ts` 与 `subagents/index.ts`（001→013/008）、`packages/host-node/package.json`（003→011）、`pnpm-lock.yaml`（003→011→follow-up）；均对应已声明依赖或后续共享接线，没有发现把无关编号混入某个实现提交的证据。

## 执行证据

- `git diff --check 55a3d2e..2eee1e1`：通过。
- 定向 Vitest：21 files / 159 tests passed。覆盖 credentials、bounded body、server package boundary、三表 provider parity、history target、current-turn/recovery、plan persistence、model settings、archive producer/replay、continuation parser、workspace hash、IndexedDB primitives、delegate schema/docs、workspace envelope 与三平台 shell contract。
- 测试全绿只能证明当前枚举与当前行为；I1–I4 是 owner/SRP/未来漂移证据，不能由当前样本绿灯抵消。
