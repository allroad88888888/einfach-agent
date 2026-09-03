APPROVED

# 016 Important fixes 整树最终独立审查

结论：016 的四个 Important 均已关闭；未发现 Critical 或 Important 遗留，也未发现行为、legacy、fail-closed、依赖图、提交隔离或文件职责回归。四项在 `c804cd4..HEAD` 中分别对应一个线性、可独立回滚的产品提交。

## 审查口径

- 完整阅读了 `index.md`、017–020 任务卡、各项 implementation/review 报告以及 016 原报告的四个 Important。
- 独立审阅了 `git log --oneline c804cd4..HEAD`、四个 commit 的路径边界和 `git diff c804cd4..HEAD` 全量产品 diff；没有把各项已有 review 结论当作代替证据。
- 执行了只读静态扫描、物理行数统计与 `git diff --check c804cd4..HEAD`；后者无输出。按约定未重跑编排者已经通过的全量命令：`pnpm build` 通过，`pnpm test` 为 787 files / 6419 tests passed，3 files / 3 tests skipped。
- 产品代码、任务卡和 index 均未修改；本 reviewer 只新增本报告。

## Findings

### Critical

无。

### Important

无。四个原 Important 的逐项关闭证据见下文。

### Minor

1. 018 使公开 `@einfach-agent/core/subagents` 面上的 `ChildStartedArchivePayload` 及 creator 入参从宽泛 `string` / `readonly string[]` 收窄为 `SubagentToolProfile` / `readonly DelegatableDangerousTool[]`（`archiveEventPayload.ts:23-49`）。这与 014 M-1 已记账的 TypeScript source-compatibility 影响同类：使用宽泛 `string[]` 变量的外部源码可能需要先收窄。这是 018 “持久化协议类型必须消费公共能力集合”的显式验收内容，没有改变仓内运行时能力，不阻断批准。
2. 020 的两处纯记账陈旧仍存在：`workspace/write/guard.test.ts:82-83` 还说固定向量位于 `read/content.test.ts`，实际已迁到 `common/contentHash.test.ts`；`020-report.md` 对宽泛 SHA-256 搜索的 concern 已被任务卡的 `contentSha256` 精确定义计数裁决取代。二者均不影响产品行为。

## 四个 Important 逐项关闭

### 1. current-turn 唯一 owner：已关闭

- `packages/agent-core/src/runtime/activeTurnItems.ts:12-24` 仍是 canonical `currentTurnStartIndex(items, turnId)`：优先精确锚定 `turnId`，缺锚时回退最后一条 user，无 user 时返回 `0`。该实现在本 diff 中未改动。
- `runtime/commands/turnSafety.ts` 已删除忽略 `turnId`、无 user 时返回 `-1` 的旧同名函数，现只负责 `currentTurnHasSideEffects`（`:1-9`）。
- 静态扫描 `packages/agent-core/src/runtime` 仅有 `activeTurnItems.ts:12` 一处函数定义；recovery 与 tool-outcome 消费方仍直接导入 canonical owner。
- 新 `turnSafety.test.ts` 直接覆盖 safe tool、特别副作用工具 `run_task` 和 dangerous tool；生产 side-effect 函数本身无 diff，故未改变判定。

### 2. subagent 五类能力值链路：已关闭

- 唯一值 owner 清晰：model tier / task category / risk level 来自 `subagents/types.ts:11-25`，tool profile 来自 `subagents/toolProfile.ts:9-17`，confirmed tool 来自 `runtime/dangerousTools.ts:36-48,73-75`。
- input 仍用这五个 owner 归一化与拒绝未知值；policy 携带已归一化的 typed spec，并对宿主传入的 capability `toolNames` 再执行 `isDelegatableDangerousTool` 边界检查（`delegationPolicy.ts:97-120`）。未知工具、scope/correlation 不符或子级扩权仍 fail closed。
- profile / confirmed tools 以公共类型经 policy 进入 `runtimeState.ts:39-42`，再进入 `RunChildAgentInput`（`childAgentLoop.ts:50-64`）；model tier / category / risk 继续随 typed `DelegateAgentChildSpec` 进入 routing 与 child，不经过宽泛字符串状态容器。
- continuation snapshot 的五类字段都直接引用公共类型（`continuationDescriptor.ts:16-32`）；parser 直接使用四个 readonly tuple 和 confirmed-tool predicate（`continuationDescriptorParser.ts:74-120,165-175`），不再手写 union/allowlist。表驱动用例遍历全部公开值，并对五类未知值逐项证明 reconciliation fail-closed。
- archive v1 现有的能力字段（实际 routed model tier、tool profile、confirmed tools）均引用同一公共类型并使用同一 runtime 值集合解码（`archiveEventPayload.ts:23-104,131-185,227-252`）。task category / risk level 是原始路由输入，保存在 continuation typed spec 中并用于产生 routed tier；它们不是现有 child-started/finished archive v1 字段，本次没有为去重目标扩张持久化 schema。
- archive 表驱动测试遍历其全部 canonical model tiers（started/finished）、profiles 和 confirmed tools，并覆盖未知 v1 能力、未知 version 与未知 finished tier。无版本 legacy payload 仍宽松投影可识别字段，未知能力不会使旧事件整体失效；带版本数据则严格拒绝，没有降级旁路。

### 3. JSON Content-Type 独立 owner：已关闭

- `apps/server/src/jsonContentType.ts:10-15` 是 `hasJsonContentType` 唯一实现位置；文件只负责判断 JSON media type。
- `invokeRoute.ts:28` 与 `modelRoute.ts:52` 直接导入该 owner；`invokeRouteBody.ts` 只保留 invoke body 投影，`modelRouteBody.ts` 不再跨业务 re-export。
- 实现是原函数的原样迁移：缺失/非字符串头拒绝，只接受大小写不敏感的 `application/json`，允许参数。两路由的 415 分支顺序、状态码、`unsupported_media_type` 错误码和文案均未改变。
- 旧 Content-Type 正反例完整迁至 `jsonContentType.test.ts`；invoke body 剩余测试只删除了已迁走的引用与用例。

### 4. workspace content hash 唯一 owner：已关闭

- `packages/host-node/src/workspace/common/contentHash.ts:3-16` 同时拥有 `sha256:<64 lowercase hex>` 格式错误、严格 predicate 与字节级 `contentSha256(bytes)`。精确扫描 `function contentSha256` 仅命中该处。
- 旧 `workspace/change/contentHash.ts` 及其测试已删除；`workspace/read/content.ts` 的第二份 SHA-256 实现已删除，该文件恢复为文本收窄职责。无旧 owner import/re-export 残留。
- bytes/lines read 对整文件原始字节直接计算（`read/bytesRead.ts:192`、`read/linesRead.ts:149`）；write/patch guard 在调用点显式 `Buffer.from(current, 'utf8')`（`write/guard.ts:60`、`patch/guard.ts:40`）。对可接受的 UTF-8 文本，输入字节与原语义等价。
- 空串、ASCII `abc`、多字节 `你好` 用硬编码独立摘要固定算法/编码，格式用例覆盖缺前缀、大写、尾随换行、长度和非 hex。write/patch 格式错误、不匹配错误和分支顺序未改变。
- workspace 内其他 SHA-256 调用分别用于 journal snapshot、path fingerprint 和 run-index cursor，输入、输出格式与信任边界不同；未强行并入 content hash owner 是正确的抽象边界。

## 依赖图、文件职责与行数

- 018 的新 value import 仅从 archive/parser/input 指向 `dangerousTools.ts`、`types.ts`、`toolProfile.ts` 三个 owner；`types.ts` 对后两类能力的引用是 type-only，owner 也不反向引用 continuation/archive。content hash 和 JSON Content-Type 都是无业务反向边的叶模块。未发现新运行时循环。
- 按 `one-file-one-thing` 的一句话、命名与引用聚类测试，新拆出的 `jsonContentType.ts`、`common/contentHash.ts` 及对应测试职责单一；continuation descriptor/parser、archive codec 也分别围绕单一协议职责，没有假拆分。
- 所有新增/修改产品与测试文件均 `<=300` 物理行。上限处为存量、本轮只改 import 的 `read/linesRead.test.ts` 300 行；其次是只改类型接线的 `childAgentLoop.ts` 296 行。无需使用 500 行复杂文件例外，也没有新的超限文件。

## 提交隔离

`c804cd4..HEAD` 恰好四个线性提交：

| commit | 任务 | 产品边界 |
| --- | --- | --- |
| `1974e1f` | 019 | 仅 server JSON Content-Type owner、两路由接线与测试迁移 |
| `23f5924` | 017 | 仅删除 stale current-turn owner 并补 side-effect 测试 |
| `aea7d7d` | 020 | 仅 workspace content hash owner 迁移、消费方接线与测试 |
| `bfb7e85` | 018 | 仅 subagent capability 持久化 codec/类型链路与测试 |

每个提交另含自身任务卡和 implementation/review 报告，没有夹带其他产品域；父链连续，没有 squash/amend 原历史。

## 原 #10、既有 Minor 与回归结论

- 原 #10 继续明确未实施：`deepseekFiles.ts`、`deepseekFileDisposal.ts`、`kimiFiles.ts`、`kimiFileDisposal.ts` 对 `c804cd4..HEAD` 的 diff 均为空，没有合并 provider file lifecycle。
- 014 的 `confirmedTools` 公开 TypeScript 收窄记账仍在（并有上述同类 Minor）；归档 CLI/producer 对 `.` / `..` 的非常规 ID 映射未触及。旧 current-turn helper 是本次被 016 升级为 Important 后经明确授权修复，不是暗改 Minor。
- 016 的两个 Minor 未暗修：model body wrapper 仍无直接映射测试，server package-boundary 测试仍未扩展 CommonJS `require` 识别。它们在当前 ESM 源码和本轮边界内仍不构成行为回归。
- 除显式要求的 versioned archive 能力闭集收紧外，未发现请求/响应、恢复、子 Agent 授权、HTTP 错误、workspace 编码/哈希或 legacy 解码回归。未知/损坏输入依然 fail closed/fail loud，正常旧数据仍可读。

## 最终回执

APPROVED — 016 的四个 Important 已逐项关闭；四个产品提交隔离正确，无 Critical/Important 遗留，无新行为或 legacy/fail-closed 回归。
