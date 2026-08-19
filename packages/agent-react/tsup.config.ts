// @einfach-agent/react-plugin 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // 两个运行时依赖 @einfach-agent/core、react 都在本包 peerDependencies，tsup 的自动 external
  // 按包名前缀匹配，`react/jsx-runtime`（tsconfig 的 `jsx: "react-jsx"` 触发的自动运行时
  // import）与 `@einfach-agent/core/timeline` 这类子路径一并覆盖，故留空——已实测 dist 无内联。
  external: [],
})
