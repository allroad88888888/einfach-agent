# 013 独立审查

结论：`APPROVED`

审查方式：只读任务卡、执行报告、`git diff 82431a4 --` 的任务范围，并逐个检查所有未跟踪 owner/test。按要求没有重跑执行报告声称的定向测试、`pnpm build` 或 `pnpm test`；下文对运行结果的判断以报告记录为证，对实现与测试内容作了独立静态核对。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

执行报告记录的两次全量并发超时抖动和存量 `modelTurn.test.ts` 超限均已如实列入疑虑；前者最终原命令全绿且隔离复跑通过，后者本次 `872 -> 872` 未增长，均不构成本任务拒绝项。

## 七域逐项核对

### A. server bounded body：✅

- `apps/server/src/boundedJsonBody.ts:19-49` 使用 `Buffer.byteLength` 的实际 chunk 字节累加，仅在 `total > maxBytes` 时拒绝；超限后清空已缓存 chunks，但保留 `data` 监听直到 `end`，因此继续排空而不再增长内存。
- `apps/server/src/boundedJsonBody.ts:24-33,45-63` 的成功、空体、非法 JSON、超限均经 `finish` 单次结算并移除 `data/end/error`；传输 `error` 单独 reject、同样清理，`settled` 防止重复结算。该逻辑与两个被替换 reader 的基线实现逐段等价。
- `apps/server/src/invokeRouteBody.ts:60-67` 保留 invoke 的空 body=`empty`、JSON 顶层必须是非数组 object；`apps/server/src/modelRouteBody.ts:66-68` 单独把共享 reader 的 `empty` 转回 `invalid-json`，没有抹平端点差异。
- 路由层仍分别把 `too-large` 映射为 413、`invalid-json/not-object` 映射为 400；reader reject 仍冒泡到既有外层 500。新增契约测试覆盖跨块实际字节、超限后继续接收、监听器清理和非 `Error` 传输错误。

### B. observability IDB：✅

- `packages/observability-idb/src/indexedDbLogDatabase.ts:3-31` 集中原 DB 名、version、span/event store、keyPath，以及 `traceId/startedAt/timestamp` indexes；upgrade/open error/blocked 文案与两份基线副本一致。
- writer 在 `indexedDbLogDriver.ts:11-30` 仍分别吞掉 open 与 transaction/write 失败并关闭成功打开的 DB，保持 best-effort；reader 在 `indexedDbLogReader.ts:9-42` 不吞 open/read/transaction 失败，并在 `finally` 关闭 DB，保持 reader throw 边界。
- 新契约测试验证 fresh upgrade 的两 store/四 index、writer→reader 互通和 IndexedDB 缺失时的 open error；静态路径同时确认 writer/reader 的失败策略没有被共享 owner 合并。

### C. persistence IDB transaction：✅

- `packages/persistence-idb/src/indexedDbTransaction.ts:22-41` 仅在 transaction `complete` 后 resolve；主动 fail 和 operation 同步 throw 都先保留原始错误再 abort；`error/abort` 竞态即使都触发也由 Promise 首次结算决定，并优先使用原错误，再回退 transaction error/调用域文案。
- history/recovery 分别传入原有 `IndexedDB history log transaction ...` 与 `IndexedDB recovery transaction ...` 文案，store name 也仍由各域显式提供，没有错误文本漂移。
- 各 request 仍在 transaction operation 内注册回调；recovery 的 read→条件 put 仍在同一 readwrite transaction 中，结果虽然可先设置，但外层不会早于 transaction complete 返回。request error/decode error 仍走 `fail` 并中止整笔 transaction。
- owner 契约测试覆盖 complete 后返回、主动 fail、同步 throw、无具体错误的外部 abort；现有 history/recovery/atomicity 测试由报告列入定向测试。

### D. FS envelope：✅

- `tools/fs/src/workspaceResultEnvelope.ts:8-32` 保留原判别规则：只有非数组 object 且 `ok` 为 boolean 才是 envelope；legacy direct result 与 `{ok:true,data}` 均投影为成功，`{ok:false,error}` 在 unwrap 边界抛原文案、在 ToolResult 边界保留原文案。
- list/read/search 分别显式传入原失败 code：`WORKSPACE_LIST_FAILED`、`WORKSPACE_READ_FAILED`、`SEARCH_FILES_FAILED`，并继续固定 `retryable:false`。
- find-test-lint 的 list failure 仍由外层 catch 变成 `COMMAND_DISCOVERY_FAILED`；单个 manifest read failure 仍被内层 catch 收成 `could not read ...` warning 后继续。共享 unwrap 没有改变 warning/throw 分层。
- 新契约测试覆盖 legacy direct、success envelope、failure envelope 与误判边界；四个 consumer 的私有 `isStructuredResult/toToolResult/unwrap` 已移除。

### E. host `pathExists`：✅

- `packages/host-node/src/workspace/common/pathExists.ts:3-12` 使用 `stat`，因此跟随 symlink，并对所有异常返回 false；契约测试固定普通文件、缺失路径、悬空软链三种结果。
- `workspace/change/pathProbe.ts:18-37` 保留原 import path 的 re-export，并继续用 `lstat` 实现独立的 `symlinkExists`；测试确认悬空软链在 `pathExists=false`、`symlinkExists=true`。
- 静态扫描 workspace/shell 后，生产代码只剩 shared owner 一处 `function pathExists`；shell、prepare、resolveWorkspacePath、gitPathspecs、patch fs/path、write pipeline/pipelineWrite 均已接入 owner，既有经 `pathProbe` 消费者继续经 re-export 接入。
- delete test harness 的 `symlinkExists as pathExists` 是合理的测试语义别名：这些删除断言需要观察悬空软链本身，不能改用跟随 symlink 的生产探针。

### F. ToolResult serialization：✅

- `packages/agent-core/src/tools/toolResultModelPayload.ts:6-18` 与三份基线投影一致：无 data 或显式 null 的 success 均回 `{ok:true}`；有 warnings 时回 `{data,warnings}`；failure 仅按原条件附加 code/hint/retryable/details，并保留 `retryable:false` 和 `details:null`。
- root `appendMappedToolResult` 显式传 `unexpected pause`；普通 child 与 timed child 显式传 `child tools cannot pause`。普通 child 的公开 `runChildTool` 返回类型本就排除 pause，宿主适配层也先把 pause 归一为该错误，因此没有引入新的可达行为差异。
- root、普通 child、timed child 三处均已接到 owner；契约测试覆盖 success/null/warnings、完整 failure optional fields 和两种 pause 文案。
- `toolLoopSupport.toolResultTrace` 保持独立 observability 投影，diff 只增加 model serializer import/调用，没有误把 trace 的 pause/result_kind/question_count 语义并入模型 payload。

### G. ModelSettings：✅

- `packages/agent-core/src/state/modelSettingsSchema.ts:40-60` 由同一字段 schema 派生 required/optional 字段和 `ModelSettings` 类型；vendor/model required，thinking/temperature/max_tokens/vendorSettings optional，字段类型与原 `core.type.ts` 一致。
- `modelSettingsSchema.ts:32-37,69-76` 保留恢复边界约束：数字必须 finite 且拒绝 `-0`，vendorSettings 必须为非数组 object，未知 key、缺 required 或类型错误均 fail closed。新测试逐类固定这些约束。
- `MODEL_SETTINGS_FIELDS` 由 schema keys 生成，settings-bag migration 仍把非通用顶层字段搬进 vendorSettings、袋内同名值优先、无迁移时保持同一引用；既有 migration 测试继续覆盖该行为。
- recovery codec 直接复用 `isModelSettings`，其余 JSON-safe/cycle/prototype 校验仍留在 recovery codec，没有放宽恢复信任边界。
- `core.type.ts` 从 schema import 并 re-export `ModelSettings/ModelVendor`；根 `src/index.ts` 原有 `ModelSettings` public re-export 因此保持有效。schema 只 type-import `@einfach-agent/ai`，没有回引 core，未形成循环依赖。

## 额外验收

- 分页测试：✅ `runtime/modelTurn.test.ts:262-280` 现在沿 cursor 收集真实 registry 的全部分页，仍显式要求 server tool、internal tool，并要求包含 `toolRegistry.list()` 的每一项；英文 search 验收未删。web 环境仍枚举并排除全部 server names（243-259）。此外既有 73-tool 契约（411-427）继续严格验证逐页上限、total、完整顺序和无重复，因此修正没有弱化 server/internal/all-registry 验收。
- 范围：✅ tracked 产品 diff 全部位于任务 `files`；未跟踪产品文件仅为七个 owner 及其七个契约测试，也全部在范围内。`.tasks/deduplicate-contracts/index.md`、任务卡和执行报告是编排账本，不属于产品 diff；本 reviewer 未改它们。
- 去重：✅ 静态扫描只剩各领域 owner 与合法的不同语义实现；`sessionsPersistence.ts` 的 `openDb` 属于另一个 sessions DB，不是 observability 重复。
- 行数：✅ 七个新增 owner/test 最大 77 行；其余大改普通文件不超过 300。`find-test-lint-commands.ts` 315→297、`childAgentToolCalls.ts` 292→281、`recoverySnapshot.codec.ts` 288→279。唯一存量超限 `modelTurn.test.ts` 为 872→872，未增长。

## 任务验收标准

1. ✅ 执行报告记录综合定向 32 files / 348 tests 通过，覆盖两种 server body、两个 IDB 包、FS、host、agent-core tool/state；另记录分页测试 41 tests 通过。
2. ✅ 七个 owner 均有独立契约测试，public API/错误文案/端点差异经静态 diff 保持兼容。
3. ✅ `rg` 静态核对与报告相符：七类目标副本已移除，保留项均是明确不同的信任边界或兼容 re-export。
4. ✅ 执行报告记录最终 `pnpm build` 通过、最终原样 `pnpm test` 为 783 files passed / 6370 tests passed（另 3 skipped）；本 reviewer 依指令未重跑。
5. ✅ 新增和大改普通文件满足 300 行门槛；存量 872 行测试文件只做获批小改且净行数为 0。

最终回执：`APPROVED` — 七域契约、分页扩边界、文件范围与行数门槛均通过，未发现需要修复循环的 Critical/Important 问题。
