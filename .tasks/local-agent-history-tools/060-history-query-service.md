---
id: "060"
title: 组合 query service 与 host routes
kind: leaf
parent: "3000"
depends_on: ["030", "040", "050"]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/history/historyQueryService.ts
  - packages/host-node/src/history/historyQueryService.test.ts
  - packages/host-node/src/history/historyCommands.ts
  - packages/host-node/src/history/historyCommands.test.ts
  - packages/host-node/src/history/historyServiceCursor.ts
  - packages/host-node/src/history/historyServiceCursor.test.ts
  - packages/host-node/src/history/historyRecoveryReader.ts
  - packages/host-node/src/history/historyRecoveryReader.test.ts
  - packages/host-node/src/history/historyCommandArgs.ts
  - packages/host-node/src/history/historyPageBudget.ts
  - packages/host-node/src/history/historyPageBudget.test.ts
  - packages/host-node/src/history/historyCanonicalBudget.ts
  - packages/host-node/src/history/historyCanonicalBudget.test.ts
  - packages/host-node/src/history/historyInput.ts
  - packages/host-node/src/history/historyInput.test.ts
  - packages/host-node/src/history/historyInput.ts
  - packages/host-node/src/history/historyInput.test.ts
  - packages/host-node/src/history/historyCanonicalBudget.ts
  - packages/host-node/src/history/historyCanonicalBudget.test.ts
  - packages/host-node/src/history/index.ts
  - packages/host-node/src/commandNames.ts
  - packages/host-node/src/commandNames.test.ts
  - packages/host-node/src/commandArgs.ts
  - packages/host-node/src/hostOptions.ts
  - packages/host-node/src/createNodeHostInvoke.ts
  - packages/host-node/src/createNodeHostInvoke.test.ts
  - packages/host-node/src/index.ts
---

# 组合 query service 与 host routes

## 目标

把 canonical repository、FTS 与 legacy adapters 合成为一个 provider，并通过四条 Node host command 暴露。

## service

`createNodeAgentHistoryProvider({executor,agentRollout,...})` 返回 `AgentHistoryCapabilityProvider`：

- 每次 public 方法先执行共享 `agentRollout.reconcile()`；source warning/exception 以 source-corrupt 失败，绝不 fallback。
- projection warning 返回 `PROJECTION_LAG`；canonical repository 仍按已投影 snapshot 查询，不能伪报最新。
- global list/search 只走 canonical rollout/FTS，复用030/050的排序、cursor、snapshot和100k预算。
- legacy root/child 仅在请求明确指定 target 且canonical catalog不存在时fallback，并保持partial warnings；
  不把旧目录traversal合并进global cursor。
- search 先有界追平FTS；targeted canonical不存在时才做该target的legacy search；search
  lag/unavailable与projection/source分类分离。
- `forContext({legacyWorkspaceRoot})` 只绑定 legacy locator；canonical list/search 始终覆盖全部 app-data。
- `historyServiceCursor.ts` 只负责 service-level source cursor；`historyServiceMerge.ts` 只负责稳定 merge/budget；
  `historyRecoveryReader.ts` 是默认 Node host 的只读 `Pick<RecoveryDriver,'listLatest'>` 实现，必须与现有
  SQLite recovery driver 的 validation/fail-loud 语义对拍，不能 hydrate/write store。

## host commands

新增 domain `history` 与四个命令：

- `agent_history_list`
- `agent_history_list_items`
- `agent_history_read_item`
- `agent_history_search`

`historyCommands.ts` 在自己的文件严格收窄 `{input, legacyWorkspaceRoot?}` envelope 与所有未知键；不向 289 行
`commandArgs.ts` 追加。route 仅调用 provider，不实现 SQL/FTS。隐藏 locator 不是模型 schema 字段。

`NodeHostInvokeOptions` 支持注入 borrowed `agentHistoryProvider`；CLI 注入时 host routes 与 core 共用同一实例。
server/default host 使用同一 persistence executor、app-data directory 与 rollout driver构造 provider，不创建第二
SQLite 数据库或第二 rollout driver。provider 无 disposer；现有 rollout/MCP lifecycle 不变。

## 验收

1. 五表 canonical、legacy root/child、FTS 合并行为与 warning/complete/status/cursor 逐项通过。
2. source corruption command reject；projection/search lag 返回机器可判 warning；legacy 坏行不反转分类。
3. 四命令精确注册一次，invalid/oversized/unknown-key 在 I/O 前拒绝；host command 总数与注释同步。
4. borrowed provider/driver identity 测试证明 CLI routes 不重复实例化；server default 仍能独立装配。
5. `pnpm exec vitest run packages/host-node/src/history/historyQueryService.test.ts packages/host-node/src/history/historyCommands.test.ts packages/host-node/src/createNodeHostInvoke.test.ts packages/host-node/src/commandNames.test.ts` 通过。
6. `pnpm --filter @einfach-agent/host-node build`、`pnpm check:boundaries`、`git diff --check` 与 owners `<=300` 通过。

## R1 修复门（2026-09-01 scope cut 后）

独立报告 `reports/060-review.md` 的 R1 按旧的跨来源global merge目标判FAIL。用户随后明确要求简化；
055–058取消。R2只需关闭仍在新边界内的事项：

- global list/search完全透传canonical repository/FTS语义，不读取root recovery或child目录；证明跨conversation
  canonical三页不重漏，`statuses:[]`等价omitted。
- targeted请求先独立判断canonical catalog presence，再决定legacy fallback；不能把“被status/query过滤”误当不存在。
- targeted legacy items使用简单`itemOrdinal,itemId` cursor与source snapshot；若实现成本仍扩张，可明确只支持无cursor
  单页并在超限时返回typed unavailable，而不是伪造续页。
- 四方法最终envelope在追加warning后仍<=100000；global沿用030/050 cursor，targeted legacy用小型本地预算器。
- reconcile driver reject 统一 typed `AGENT_HISTORY_SOURCE_CORRUPT` 且在其他查询 I/O前失败；projection warning
  仍只返回 `PROJECTION_LAG`。
- host route 对 trim 后 query做 1..1000 Unicode code-point校验，一次读取 offset/query；所有无效输入在
  `provider.forContext`前拒绝。
- default host只构造一个executor facade并同时交给rollout/recovery/history；注释与测试同步为46 commands。
- 删除 `commandArgs.ts` 的 history 前缀豁免，恢复全命令穷举门。history参数形状放在独立
  `historyCommandArgs.ts`（可用 module augmentation/独立聚合），不得把历史字段塞入近上限主文件。

## 禁止项

- 不新增 HTTP endpoint；复用 `/api/invoke/:command`。
- 不把 path 暴露到 tool contract，不新增 permission/approval/ancestor 判断。

## R3 修复门

依据 simplified R2 独立复审，仅关闭以下三个局部问题：

- public capability 的 targeted legacy 路径必须执行与 canonical 相同的 limit、query、roles、statuses、offset、
  includeDeleted 运行时校验，非法输入不能因 fallback 绕过合同。
- canonical page 追加 `PROJECTION_LAG` 后若超过最终 100k，必须在保留 source cursor 语义的前提下裁剪当前页并
  返回 `OUTPUT_TRUNCATED`；可容纳至少一项时不得直接抛错。
- commandNames 测试注释同步包含四条 history command；不得扩展到已取消的 global legacy merge/snapshot。
