// @einfach-agent/host-node 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  // 域目录（config/、后续的 workspace/ shell/ mcp/ …）不开 subpath：它们是路由表的**装配零件**，
  // 对外只经 createNodeHostInvoke 这一个入口生效，单独暴露只会多出一条要维护的公开面。
  entry: ['src/index.ts'],
  // 唯一声明依赖 @einfach-agent/core 已在本包 dependencies，tsup 自动 external（且本包只 import type
  // 它，产物里连引用都不会有）。`node:*` 内置模块由 esbuild 的 node platform 默认 external。
  external: [],
})
