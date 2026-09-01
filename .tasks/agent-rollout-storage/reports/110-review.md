# 110 独立复审

## VERDICT: FAIL

实现的两个 owner diff 没有放宽边界规则，也保留了命令去重断言；定向执行均通过：

- `pnpm exec vitest run scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts`：2 files、18 tests passed。
- `pnpm check:boundaries`：passed（仅既有豁免观察项）。
- `git diff --check`：passed。
- `wc -l scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts`：216、56，均小于 300。

但“注释准确”的验收尚未满足，故不能通过：

1. `scripts/check-boundaries.test.js` 的正向测试标题写为“白名单十条 subpath 与根 barrel”。真实 allowlist 是总共十个入口：根 barrel（`''`）加九个 subpath（含新增 `history`），不是十个 subpath 再加根 barrel。测试正文已经正确新增 `@einfach-agent/core/history` 的正向 import，断言也仍然保留白名单外失败；只需把标题改成与真实契约一致的“十条入口（根 barrel 加九条 subpath）”等表述。
2. 另外观察到同一命令全集的权威说明 `packages/host-node/src/commandNames.ts` 仍两次写“40 条”（总表说明与 `NodeHostCommandName` 注释），而表已经含 rollout 两条、实际为 42。这不在 110 的两个 owner 范围内，但与此次“42 条且注释准确”的最终契约相矛盾；应由命令全集的拥有任务修正，不能借测试说明掩盖它。

命令测试中的新注释本身正确：rollout 两条分别是追加原始历史与重放 SQLite 投影，长度与 `Set` 唯一性均精确断言 42；边界测试也确实为新增 `history` 保留了正向证据，且 `rootStore` 的负向/豁免/跨行断言均未删除。

## R1 correction

## VERDICT: PASS

上轮两项已更正，且本轮未改变命令数组：

- boundary 正向测试现准确写为“白名单十条入口（根 barrel + 九条 subpath）”，fixture 继续直接 import 新增的 `@einfach-agent/core/history`；白名单外、豁免与跨行负向断言仍存在。
- 命令全集的权威说明现明确“此前 40 条 + rollout 两条 = 42 条”，类型注释也为 42；命令测试的“后 14 条没有 Rust 对应物”与 42 减既有 Rust 28 条一致。相关 `40 条` 仅保留为历史阶段说明，未发现遗留的错误 `后 12 条`；rollout 数组仍是 `agent_rollout_append`、`agent_rollout_reconcile`，没有因本轮文案修正被改动。

本人复跑：

- `pnpm exec vitest run scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts`：2 files、18 tests passed。
- `pnpm check:boundaries`：passed（只有既有豁免观察项）。
- `git diff --check`：passed。
- `wc -l scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts packages/host-node/src/commandNames.ts`：216、56、141，均小于 300。
