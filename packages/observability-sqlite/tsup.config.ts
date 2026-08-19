// @einfach-agent/observability-sqlite 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // @tauri-apps/plugin-sql、@einfach-agent/core、@einfach-agent/observability-idb 都在本包
  // dependencies，tsup 自动 external。@tauri-apps/plugin-sql 是有意的硬依赖（本包按定义只在
  // Tauri 宿主下装配，V5 已定性不改为 optional peer），不跟 core 一起降级。
  external: [],
})
