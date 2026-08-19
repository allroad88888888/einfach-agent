// @einfach-agent/tools 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），负责一次性 registerStandardTools 六域。
  entry: ['src/index.ts'],
  // @einfach-agent/core 与六个 tools-* 域包都在本包 dependencies，tsup 自动 external
  // （mcp 不在其中——它是第七个域，按设计不进 standard 聚合包）。
  external: [],
})
