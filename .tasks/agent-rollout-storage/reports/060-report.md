# 060 执行报告

## 完成内容

- 新增 `buildRootRolloutDelta(previous, current)` 纯函数，将 root `RecoverySnapshotV1` 差异映射为稳定排序的 rollout mutations。
- 首次 capture 依次产生 session meta、turn context、全部 item upsert、run state；增量处理追加、内容更新、pending/plan stage 更新、重排与删除 tombstone。
- item 比较采用键排序的稳定 JSON 表示，避免对象属性顺序导致伪更新；输出不修改输入快照。
- 新增定向测试，覆盖 Unicode、tool item 与所有要求的变更场景。

## 验证

- `pnpm exec vitest run packages/agent-core/src/history/rootRolloutDelta.test.ts`：通过（7 tests）。
- `wc -l`：实现 103 行，测试 106 行，均小于 300 行；两个文件分别只负责差分与其测试。
- `git diff --check`：通过。
- `pnpm exec tsc -b --pretty false`：未通过，失败来自并行在途的 `packages/host-node/src/rollout/jsonlStore.test.ts` 对联合类型未收窄（TS2339 / TS2839）；本叶未改该文件。

## R1 修复与验证

- `previous.sessionId !== current.sessionId` 现在会在构造任何 mutation 前 fail-fast，防止旧会话的 tombstone 污染新会话的 append-only history；测试覆盖该拒绝路径。
- 将 pending finalization 与仅 `planStageId` 变化拆为独立测试，分别证明两个字段都参与 item upsert 比较。
- stable JSON 的 key 排序改为代码点比较，不再依赖运行时 locale/ICU 行为。
- `pnpm exec vitest run packages/agent-core/src/history/rootRolloutDelta.test.ts`：通过（9 tests）。
- `pnpm exec tsc -b --pretty false`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：均通过。
- `wc -l`：实现 106 行，测试 124 行，均小于 300 行；文件职责保持单一。
