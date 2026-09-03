# 013 执行报告

状态：`DONE_WITH_CONCERNS`

七个机械协议副本均已由各自领域内的窄模块接管，定向测试、`pnpm build` 与最终一轮原样 `pnpm test` 均通过；疑虑仅为全量并发测试曾出现可隔离通过的耗时抖动，以及一个本次未增长的存量超限测试文件。

## 七个子项

1. **server bounded JSON reader**
   - 新增 `apps/server/src/boundedJsonBody.ts`，唯一负责实际字节计数、超限后继续排空、JSON 解析、监听器清理与传输错误 reject。
   - `invokeRouteBody.ts` 保留自己的空 body 与顶层 object 校验；`modelRouteBody.ts` 保留空 body=`invalid-json` 的端点语义。
   - public route API、413/400/500 分界与 Content-Type 判据未改变。

2. **observability IDB schema/open**
   - 新增 `packages/observability-idb/src/indexedDbLogDatabase.ts`，统一 DB name/version、span/event stores、indexes、upgrade/open 错误语义。
   - writer 仍对 open/write 失败 best-effort 吞错；reader 仍将 open/read 错误抛给调用方，两条信任边界未合并。

3. **persistence IDB transaction**
   - 新增 `packages/persistence-idb/src/indexedDbTransaction.ts`，统一单 store transaction 的 complete/abort/error/同步异常生命周期。
   - history/recovery driver 显式传各自 store 与原错误文案，generation/tombstone/record codec 等 adapter 生命周期保持分离。

4. **FS workspace result compatibility**
   - 新增 `tools/fs/src/workspaceResultEnvelope.ts`，统一识别 legacy 直接结果与 `{ok,data|error}` envelope，并提供 unwrap/ToolResult 两种领域边界投影。
   - list/read/search 保留各自失败 code；find-test-lint 保留 failure envelope 抛错后进入原 warning/failure 流程。

5. **host `pathExists`**
   - 新增 `packages/host-node/src/workspace/common/pathExists.ts`，成为 workspace/shell 唯一的“跟随软链、任意 stat 错误算不存在”实现。
   - `workspace/change/pathProbe.ts` 保留原 import path 的 re-export；不跟随软链的 `symlinkExists` 仍独立存在。
   - delete 测试脚手架的 `pathExists` 是 `symlinkExists` 的显式别名；契约测试固定“悬空软链：pathExists=false、symlinkExists=true”。

6. **ToolResult 模型序列化**
   - 新增 `packages/agent-core/src/tools/toolResultModelPayload.ts`，统一 success/null/warnings/failure optional diagnostics 的 JSON 投影。
   - root 明确传 `unexpected pause`；普通 child/timed child 明确传 `child tools cannot pause`，不同信任边界的 wrapper 文案保持不变。

7. **ModelSettings 字段 schema**
   - 新增 `packages/agent-core/src/state/modelSettingsSchema.ts`，字段 schema 同时派生 `ModelSettings`/`ModelVendor` 类型、迁移字段集合与 recovery validator。
   - `core.type.ts` 继续从既有 public path re-export 同名类型；settings-bag migration 与 recovery codec 不再各维护字段副本。
   - 保持原约束：required vendor/model、optional 字段类型、未知字段 fail-closed、JSON finite number（含拒绝 `-0`）。

## 扩边界验收修正

- 编排者批准并把 `packages/agent-core/src/runtime/modelTurn.test.ts` 加入 files。
- 只将“registry 总数必须不超过单页且第一页含全部工具”的陈旧断言改为沿 cursor 遍历全部分页，再校验完整 registry、server/internal 可见性与既有英文搜索；未改产品逻辑。
- 文件 `872 -> 872` 行，未增长，也未对该存量超限测试做范围外重构。

## 验收命令与结果

- 综合定向：32 test files、348 tests 全通过。
  - 命令覆盖 `boundedJsonBody`、invoke/model 两种 server body route、observability/persistence 两个 IDB 包、tools/fs 五组、host workspace/shell、agent-core tool/subagent/state。
  - `pnpm exec vitest run apps/server/src/boundedJsonBody.test.ts apps/server/src/invokeRouteBody.test.ts apps/server/src/modelRoute.test.ts packages/observability-idb/src/indexedDbLogDatabase.test.ts packages/persistence-idb/src/indexedDbTransaction.test.ts packages/persistence-idb/src/indexedDbHistoryLogDriver.test.ts packages/persistence-idb/src/indexedDbRecoveryDriver.test.ts packages/persistence-idb/src/indexedDbRecoveryDriver.atomicity.integration.test.ts tools/fs/src/workspaceResultEnvelope.test.ts tools/fs/src/list-files/list-files.test.ts tools/fs/src/read-file/read-file.test.ts tools/fs/src/search-files/search-files.test.ts tools/fs/src/find-test-lint-commands/find-test-lint-commands.test.ts packages/host-node/src/workspace/common/pathExists.test.ts packages/host-node/src/shell/platform.test.ts packages/host-node/src/workspace/common/resolveWorkspacePath.test.ts packages/host-node/src/workspace/git/gitPathspecs.test.ts packages/host-node/src/workspace/write/pipeline.test.ts packages/host-node/src/workspace/patch/fs.test.ts packages/host-node/src/workspace/patch/path.test.ts packages/host-node/src/workspace/change/prepare.test.ts packages/host-node/src/workspace/delete/pipeline.test.ts packages/host-node/src/workspace/pathOps/pipeline.test.ts packages/agent-core/src/tools/toolResultModelPayload.test.ts packages/agent-core/src/tools/registry.test.ts packages/agent-core/src/subagents/runtime.childRollout.test.ts packages/agent-core/src/subagents/childAgentLoop.timed.test.ts packages/agent-core/src/state/modelSettingsSchema.test.ts packages/agent-core/src/state/persistence/settingsBagMigration.test.ts packages/agent-core/src/state/persistence/modelMigration.test.ts packages/agent-core/src/state/recoverySnapshot.type.test.ts packages/agent-core/src/state/recoveryProjection.session.test.ts`
- 扩边界单测：`pnpm exec vitest run packages/agent-core/src/runtime/modelTurn.test.ts` → 1 file、41 tests 全通过。
- 构建：最终 `pnpm build` → 通过；只有既有 Vite dynamic/static import 与大 chunk 告警。
- 全量：最终原样 `pnpm test` → 783 files passed、3 skipped；6370 tests passed、3 skipped；总时长 88.27s。
- 格式：`git diff --check` → 无输出，通过。

## `rg` 去重证据

- server：`request.on('data'` 在三文件（shared/invoke/model）中只命中 `boundedJsonBody.ts`。
- observability：DB 名、两个 store 字面量与 `indexedDB.open` 在 database/reader/writer 三文件中只命中 `indexedDbLogDatabase.ts`。
- persistence：history/recovery 中无 `function runTransaction`；`runIndexedDbTransaction` 只由共享 owner 和两个 driver 使用。
- tools/fs：四个 consumer 中 `function isStructuredResult|function toToolResult|function unwrap<` 为 0 命中；共享 owner 加四个 consumer 均命中 `workspaceResultToToolResult|unwrapWorkspaceResult`。
- host：`rg "(?:async )?function pathExists" packages/host-node/src/workspace packages/host-node/src/shell` 仅命中 `workspace/common/pathExists.ts:6`；测试脚手架保留一处语义不同的 `symlinkExists as pathExists` 显式别名。
- ToolResult：root、普通 child、timed child 与 owner 四文件均命中 `serializeToolResultForModel`；三处 consumer 不再各写 model JSON 分支。`toolLoopSupport.toolResultTrace` 的对象投影属于 observability trace，不是模型序列化，按信任边界保留。
- ModelSettings：`modelSettingsKeys|TOP_LEVEL_KEYS` 在 state 中为 0 命中；schema、settings-bag migration、recovery codec 均命中 `MODEL_SETTINGS_FIELD_SCHEMA|MODEL_SETTINGS_FIELDS|isModelSettings`。

## 行数

新增的七个 owner / 契约测试（物理行）：

| 领域 | owner | test |
|---|---:|---:|
| server bounded JSON | 65 | 51 |
| observability IDB database | 33 | 49 |
| persistence IDB transaction | 43 | 54 |
| FS workspace envelope | 33 | 33 |
| host pathExists | 13 | 26 |
| ToolResult model payload | 19 | 41 |
| ModelSettings schema | 77 | 39 |

- 所有新增文件均 `< 300`。
- 其余修改文件最高为 `find-test-lint-commands.ts` 297 行（基线 315，下降 18）、`childAgentToolCalls.ts` 281 行、`recoverySnapshot.codec.ts` 279 行，均未越过 300。
- 唯一超限是存量 `modelTurn.test.ts` 872 行；本次净行数 `872 -> 872`，符合编排者“不重构、不增长”的裁决。

## 未验证

- observability/persistence 契约使用 `fake-indexeddb`，未在真实浏览器 IndexedDB 实现上另跑手工冒烟；根构建与全量自动测试已覆盖编译/集成。
- host 符号链接契约在当前 Unix 主机验证，未另在 Windows junction/reparse point 环境执行。

## 范围外发现

- 第一次全量运行：`sourcePreflight.test.ts` 5s 超时，隔离与 `modelTurn.test.ts` 一起复跑时通过（该次隔离合计 48 tests 中仅旧 modelTurn 断言失败）。未修改业务 timeout。
- 第二次全量运行：`modelRun.planExecutionBudget.test.ts` 15s 超时；隔离复跑 1 file、6 tests 全通过，耗时约 9.48s。未修改业务 timeout。
- 第三次原样全量运行全部通过，说明上述是并发负载下的时序/资源抖动，不是本任务确定性回归。
- 工作区原有编排者维护的 `.tasks/deduplicate-contracts/index.md` 与任务卡改动均未触碰、未还原。

## 疑虑

- 全量 suite 对机器并发负载较敏感，两次运行分别出现不同长耗时测试的孤立 timeout；虽然最终原命令全绿且隔离均通过，CI 慢机仍可能偶发。
- `modelTurn.test.ts` 872 行远超 300/500 规则；本次只做获批的小改并保持行数不增长，长期 review 成本仍在。

## 建议

- 后续独立任务按现有 `describe` 领域拆分 `modelTurn.test.ts`（环境过滤、loaded-tool 选择、manifest cursor/search、schema canonicalization），不要在本机械提交中混入。
- 单独分析全量 Vitest worker 并发与上述耗时测试的资源竞争；优先减少共享资源/真实等待，再决定是否调整测试级 timeout。
- 由编排者按任务路径审查、暂存并形成原编号 013 的单一 commit；执行 agent 未 stage、未 commit。
