// @einfach-agent/observability-sqlite 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // @einfach-agent/core、@einfach-agent/observability-idb 在本包 dependencies，tsup 自动 external。
  // P4 之后本包**不再 import 任何具体 SQL 上游包**：SQL 执行面由装配层经 configureTraceSqlExecutor
  // 注入，`@tauri-apps/plugin-sql` 的唯一 import 点是 apps/web/src/persistence/tauriSqlExecutor.ts
  // （P1 已搬过去，两个 driver 包共用它）。package.json 里那条 dependency 声明因此已是残留，
  // 待随一次 lockfile 刷新与 persistence-sqlite 的同款残留一并摘掉（单独改 package.json 会让
  // CI 的 pnpm install --frozen-lockfile 变红）。
  external: [],
})
