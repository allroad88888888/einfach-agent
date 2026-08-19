# 上下文缓存请求组装归因交接

日期：2026-08-04

状态：**归因完成；P0/P1/P2 已实施**（`85b4d96` 多因子 epoch 归因、`043cce5` 计划内工具 pin、`d3c0ce5` 计划定义/状态拆分），待按「复测方法」用新采样验收
适用模型：`deepseek-v4-flash`

## 给接手 agent 的结论

本轮低命中不是稳定 system 前缀、`transformContext` 或 `prepareRequest` 改写造成的。12 轮实测中，事实历史只追加、不重写；稳定前缀和两个请求 hook 均未变化。

实际可控的前缀失效来源有两类：

1. 结构化计划运行期间，lazy tool schema 分四步扩容；每次工具集合变化都改变 provider 请求中的 tools 段。
2. `plan_snapshot` 和 `tool_failure_notice` 位于动态控制尾部，历史新增会插入到其前面；控制项本身变化时，provider 只能复用到旧历史末尾。

最高优先级是**在活跃计划内稳定工具 profile**；第二优先级是**缩小并稳定计划快照的动态尾部**。不要把问题归因给压缩投影或 provider 的 `cache_id`：本项目没有也不应发送 `cache_id`。

## 已实现的诊断能力

提交 `b208708`（`feat(cache): attribute request assembly changes`）新增隐私安全的请求组装快照。它只记录 hash、item 数、工具名和布尔差异，不记录 prompt 或计划正文。

| 位置 | 职责 |
| --- | --- |
| [`contextRequestAssemblyDiagnostics.ts`](../packages/agent-core/src/runtime/contextRequestAssemblyDiagnostics.ts) | 对 raw、hook 后与最终请求做脱敏边界快照 |
| [`modelTurnRequester.ts`](../packages/agent-core/src/runtime/modelTurnRequester.ts) | 在 `transformContext` / `prepareRequest` 前后写入 trace |
| [`toolLoopCycle.ts`](../packages/agent-core/src/runtime/toolLoopCycle.ts) | 为计划快照、计划续接、工具失败提示显式标记来源 |
| [`report.js`](../scripts/cache-investigation/report.js) | 从 SQLite 输出逐轮组装来源归因 |
| [`lib.js`](../scripts/cache-investigation/lib.js) | 计算非互斥的相邻轮差异 |

相关测试已经通过：`contextRequestAssemblyDiagnostics.test.ts`、`contextProjectionDiagnostics.test.ts`、`modelTurnRequester.trace.test.ts`、`scripts/cache-investigation/lib.test.js`，以及 `pnpm exec tsc -b --pretty false`。

## 本次实测证据

测试 run：`35b27b74-4ab0-4f1d-8b46-64326b8de5e9`

采样：12 条 `llm.context_snapshot` 与 12 条成功 `llm.chat`。
加权 provider usage：命中 `51,456` token、未命中 `78,467` token，命中率 **39.6%**；历史统计基线为 **63.9%**。

| 维度 | 结果 | 说明 |
| --- | --- | --- |
| 压缩 | 未触发 | 本 run 未越过 20 万 token 软上限，不能用于评价压缩复用 |
| 稳定前缀 | 12 轮均未变 | 排除 system / 静态 instructions 改写 |
| `transformContext` | 0 次改写 | 排除 transform hook |
| `prepareRequest` | 0 次改写 | 排除 prepare hook |
| 历史投影 | 全为 `fact_appended` | 事实历史只追加，没有 `fact_rewritten` |
| `plan_continuation` | 0 次 | 本样本没有此控制项 |
| 工具集合 | 5 个版本、4 次变化 | 终态 8 个工具；`tool.schema_requested` 7 次，`tool.schema_not_loaded` 0 次 |
| tracker epoch | `profile_changed` 4、`dynamic_control_changed` 4 | 单一 epoch reason 会掩盖同轮的其他变化，见下文 |

逐轮的精确来源如下；省略的相邻轮表示此类来源未变。

| 相邻轮 | 请求组装变化 |
| --- | --- |
| 1 → 2 | 工具集合从 `request_tool_schema` 变为计划核心工具集 |
| 3 → 4 | `plan_snapshot` 变化；新增 `read_file` schema |
| 4 → 5 | `plan_snapshot` 变化 |
| 5 → 6 | 新增 `tool_failure_notice` |
| 6 → 7 | 移除 `tool_failure_notice`；新增 `list_files` schema |
| 8 → 9 | `plan_snapshot` 变化 |
| 9 → 10 | 新增 `rg_search` schema |
| 11 → 12 | `plan_snapshot` 被移除 |

因此 6 → 7 同时发生两类变化，但旧 tracker 只显示 `profile_changed`。**不得**再用 `cache_epoch_reason` 单字段认定唯一根因；交接后的分析必须以 `请求组装来源归因` 段为准。

## 接手后的实施建议

### P0：先补齐多因子显示（低风险）

`ContextCacheTracker` 仍只有一个按优先级选出的 `cache_epoch_reason`。把它保留为 UI 摘要，但新增一个非互斥数组或布尔字段，例如 `cache_epoch_causes`，同时表达工具变化和动态尾巴变化。这样 6 → 7 不会被错误展示成只有工具问题。

入口：[`contextCache.ts`](../packages/agent-core/src/runtime/contextCache.ts)。验收：单测覆盖同一轮工具集合变更 + 控制项变更；trace/report 两者都能显示两项原因。

### P1：活跃计划内稳定工具 profile（最高收益）

先阅读 [`toolLoading.ts`](../packages/agent-core/src/runtime/toolLoading.ts) 与 `modelTurn.ts` 的 `buildTurnTools`，确认当前 `visible` 及 `maxTurnTools` 的边界。建议只在**已创建且未结束的结构化计划**内采用有界 sticky profile：

- 计划核心工具保持可见；计划中已经按需加载过的工具，在该计划结束前不再卸载。
- 仍遵守 `maxTurnTools` 与 provider schema 限额；超限时需要明确、可审计的淘汰策略，不能悄悄把全部工具塞进请求。
- plan 完成、取消、revert 或新 run 时清理 pin，避免跨计划无限膨胀。
- 不改变“未加载工具不得执行”的安全闸门；只减少后续轮的 schema 集合来回变化。

验收：同一类计划任务中 `tool_set_fingerprint` 的版本数显著低于当前 5 个；`tool.schema_not_loaded` 仍为 0；功能与工具预算回归测试通过。provider 命中率需要至少三次相同任务的加权统计，不以单轮结果作硬门槛。

### P2：稳定计划动态控制尾巴（中等风险）

先检查 `toolLoopPlan.ts` 生成 `currentPlanContext` 的内容和更新频率。目标不是删除计划信息，而是把不会变的计划定义与频繁更新的执行状态分离：静态定义进入可复用历史/事实段，动态状态只保留简短、稳定格式的尾部摘要。

验收：计划推进仍正确；`plan_snapshot` 在无实质状态变化时 fingerprint 不变；每次状态变化的控制项 token 数和变更次数可在 trace 中量化。不要仅为缓存把执行状态藏起来，否则会损害模型可靠性。

## 复测方法

1. 起本机服务：`pnpm serve`，浏览器打开它（**要有本机后端**，纯静态产物没有 SQL 通路、trace 查不到）。
2. 在同一会话创建一个会触发结构化计划和多个按需工具加载的只读任务，完成至少 10 个模型轮次；不要混入文件写入、shell 或 worktree 操作。
3. 记录该 run id，然后执行：

   ```sh
   node scripts/cache-investigation/report.js --run <run-id>
   ```

4. 核对三处输出：
   - “请求组装来源归因”列出所有并发变化；
   - F6 按 `tool_set_fingerprint` 而非工具数量统计版本；
   - provider hit/miss 只取 `llm.chat` 成功 span 的 usage。
5. 对优化前后各做至少 3 个同类 run，按总 hit / (总 hit + 总 miss) 比较。单轮低命中仍可能是 provider best-effort 路由或建缓存延迟，不能单独判为本地回归。

## 不要做的事

- 不创建或传递 `cache_id`，也不尝试只发送“未命中后缀”；完整有效上下文仍必须发送。
- 不为追求命中率而关闭 lazy loading、绕过工具执行闸门，或无上限固定所有 schema。
- 不把未触发压缩的本次 run 当作压缩优化的成败证据。
- 不创建 worktree；每个可独立回退的实现改动单独提交。

## 关联资料

- [缓存契约](context-caching.md)：provider 自动缓存的边界。
- [上一批只读回归观察](context-cache-regression-observation-2026-08-04.md)：压缩投影问题与 provider 波动。
- [缓存后续项](context-cache-followups.md)：F1/F2/F6 的历史验收口径。
- 提交序列：`cdbcaec`（增量投影）→ `df7b728`（tracker 归因）→ `0210e5d`（投影 trace）→ `b208708`（本次组装归因）。
