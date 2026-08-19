// @einfach-agent/persistence-sqlite 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // @einfach-agent/core 在本包 dependencies，tsup 自动 external。
  // P1 之后本包**不再 import 任何具体 SQL 上游包**：SQL 执行面由装配层经 configureSqlExecutor
  // 注入（浏览器/CLI 两态都打到 `POST /api/invoke/sqlite_*`，见 apps/web/src/persistence/
  // serverSqlExecutor.ts）。因此本包没有任何需要手动 external 的上游。
  external: [],
})
