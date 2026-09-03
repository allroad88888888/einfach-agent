# 011 recovery read facade 交付报告

状态：完成。

## 摘要

- `persistence-sqlite` 新增并导出只读 `createSqliteRecoveryReader(executor)`；它复用 SQLite recovery 的既有 row codec。
- host history reader 现在只委托该 facade，不再持有 SQLite 私有表、列、JSON 或 generation/tombstone 解析规则。
- 未修改 recovery 写入或 tombstone 行为。
- R1：SQLite row 的四个边界列均按 `unknown` 接收；codec 在 tombstone 过滤前验证其运行时形状，损坏行继续 fail-loud。

## 逐项验收

1. 通过：`pnpm exec vitest run packages/persistence-sqlite/src/sqliteRecoveryDriver.test.ts packages/persistence-sqlite/src/sqliteRecoveryDriver.atomicity.integration.test.ts packages/host-node/src/history/historyRecoveryReader.test.ts`，3 files / 14 tests 全绿。
2. 通过：`historyRecoveryReader.ts` 不含 `recovery_snapshots`、`JSON.parse`、`validateRecoverySnapshot` 或 generation 解析；只委托 persistence facade。
3. 通过：persistence facade 测试覆盖 active 返回、合法 tombstone 隐身、损坏 JSON、snapshot/列 generation 不匹配，以及 session_id、generation、deleted、snapshot 四列类型损坏（含损坏 tombstone）均 fail-loud；既有测试继续覆盖条件写入的 generation 新旧边界。
4. 通过：`pnpm exec tsc -b packages/persistence-sqlite/tsconfig.json packages/host-node/tsconfig.json`。
5. 通过：`git diff --check`；改动文件均低于 300 行。

## 未验证

- 未运行全仓测试。
- 未运行发布包安装或端到端 history 查询。

## 范围外发现

- 工作区已有 `.tasks/deduplicate-contracts/index.md` 修改及两张未跟踪任务卡；均未触碰。

## 疑虑

- 无阻断疑虑；批准后，`pnpm-lock.yaml` 仅补充了 host-node 的必需 workspace importer 记录。

## 建议

- 提交前可按变更风险决定是否补跑 host history 全部测试。

## 锁文件复验

- 通过：`pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile` 已生成 host-node importer 记录。
- 通过：`pnpm install --lockfile-only --ignore-scripts --frozen-lockfile`。

## R1 审查修复

- 修复：不再将 SQLite 返回 row 声明为可信字段；`listLatest` 改为交给 codec 自行验证 row key，避免未验证 key 的自比较。
- 验证：R1 后重跑上述定向测试、指定 TypeScript build 与 `git diff --check`，均通过。
