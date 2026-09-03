---
id: 011
title: history 通过 persistence facade 读取 recovery 数据
kind: leaf
parent: 000
depends_on: [005]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 9316692
files:
  - packages/persistence-sqlite/src/sqliteRecoveryDriver.ts
  - packages/persistence-sqlite/src/sqliteRecoveryDriver.test.ts
  - packages/persistence-sqlite/src/index.ts
  - packages/persistence-sqlite/package.json
  - packages/host-node/src/history/historyRecoveryReader.ts
  - packages/host-node/src/history/historyRecoveryReader.test.ts
  - packages/host-node/package.json
  - pnpm-lock.yaml
---

# history 通过 persistence facade 读取 recovery 数据

## 目标
history 查询通过 persistence-sqlite 提供的只读 facade 获取最新 recovery 记录，不再直接依赖私有表、列名和 row codec。

## 交付边界
只读 facade、package export、host history 接线和兼容测试共同交付。不得把 history 业务规则下沉进 persistence，也不得改变 recovery 写入或 tombstone 语义。

## 上下文
- 正式 schema/codec 在 `packages/persistence-sqlite/src/sqliteRecoveryDriver.ts` 与 `sqliteShared.ts`。
- `packages/host-node/src/history/historyRecoveryReader.ts` 当前直接查询 `recovery_snapshots` 并复制 JSON/generation/tombstone 校验。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- persistence-sqlite recovery storage 的现有数据库连接和 row codec。
### 产出
- 窄的只读 latest-recovery facade 或 `Pick<RecoveryDriver, 'listLatest'>` 等价接口。

## 验收标准
1. persistence SQLite recovery 与 host history recovery reader 测试全部通过。
2. `historyRecoveryReader.ts` 不再出现私有表名或手写 row 字段解析。
3. active、tombstone、corrupt JSON、generation 边界行为有测试覆盖。
4. `pnpm exec tsc -b packages/persistence-sqlite/tsconfig.json packages/host-node/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：依赖 005 完成，派发执行 agent，base `9316692`。
- 2026-09-03：host-node 新增 persistence-sqlite 发布依赖，扩展 files 纳入 `pnpm-lock.yaml`；冻结锁检查通过后方可审查。
- 2026-09-03：首审 REJECTED；R1 要求 SQLite row 字段按 unknown 边界严格收窄，先校验 key/列类型再处理 tombstone，并补坏列 fail-loud 测试。
- 2026-09-03：R1 独立复审 APPROVED；编排者复跑 14 tests 通过，准予提交。
