// @einfach-agent/ai 的构建入口——发包骨架的试点包，共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // 本包零运行时依赖：package.json 没有 dependencies/peerDependencies，源码里也没有任何
  // 非相对 import（只用 fetch 与自身类型），所以既没有自动 external 也不需要手写补充。
  external: [],
})
