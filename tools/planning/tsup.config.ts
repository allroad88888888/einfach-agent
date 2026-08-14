// @web-agent/tools-planning 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts）。
  entry: ['src/index.ts'],
  // 唯一运行时依赖 @web-agent/core 已在本包 dependencies，tsup 自动 external。
  external: [],
})
