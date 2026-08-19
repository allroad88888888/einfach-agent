// @einfach-agent/observability-sqlite 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // @einfach-agent/core、@einfach-agent/observability-idb 在本包 dependencies，tsup 自动 external。
  // P4 之后本包**不再 import 任何具体 SQL 上游包**：SQL 执行面由装配层经 configureTraceSqlExecutor
  // 注入（唯一实现是 apps/web/src/persistence/serverSqlExecutor.ts，两个 driver 包共用它）。
  // 因此本包没有任何需要手动 external 的上游。
  external: [],
})
