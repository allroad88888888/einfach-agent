// @einfach-agent/host-node 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  // 域目录（config/、后续的 workspace/ shell/ mcp/ …）不开 subpath：它们是路由表的**装配零件**，
  // 对外只经 createNodeHostInvoke 这一个入口生效，单独暴露只会多出一条要维护的公开面。
  entry: ['src/index.ts'],
  // manifest 声明的 @einfach-agent/ai 与 @einfach-agent/core 依赖均由 tsup 自动 external；
  // `node:*` 内置模块由 esbuild 的 node platform 默认 external。
  external: [],
})
