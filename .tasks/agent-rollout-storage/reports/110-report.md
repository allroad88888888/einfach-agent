# 110 同步最终回归契约：执行报告

## 修改

- `scripts/check-boundaries.test.js`：把三处错误消息同步为“白名单十条”，并把正向用例准确表述为“根 barrel + 九条 subpath”；加入 `@einfach-agent/core/history` 的正向 import fixture。白名单外深导入仍必须失败。
- `packages/host-node/src/commandNames.ts` 与 `commandNames.test.ts`：把精确长度和 Set 唯一性从 40 同步为 42；说明此前 40 条加上 `agent_rollout_append`（追加原始历史）和 `agent_rollout_reconcile`（重放 SQLite 投影）成为 42 条，且无 Rust 对应物的后段计数相应为 14。

没有放宽边界门禁、删除断言或修改产品代码。

## 验证

```text
pnpm exec vitest run scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts
2 files passed, 18 tests passed

pnpm check:boundaries
passed (939 non-test TS/TSX files, 7 effective rules; existing approved observations only)

git diff --check
passed

wc -l scripts/check-boundaries.test.js packages/host-node/src/commandNames.ts packages/host-node/src/commandNames.test.ts
216 scripts/check-boundaries.test.js
141 packages/host-node/src/commandNames.ts
 56 packages/host-node/src/commandNames.test.ts
```

三个 owner 均低于 300 行。
