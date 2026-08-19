// @einfach-agent/tools-skills 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts）。
  entry: ['src/index.ts'],
  // 唯一运行时依赖 @einfach-agent/core 已在本包 package.json 的 dependencies 里，tsup 自动 external；
  // 内置 skill 正文（`*.md?raw`）由预设默认挂的 raw 插件内联，不是依赖。
  external: [],
})
