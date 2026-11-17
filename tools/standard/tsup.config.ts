// @einfach-agent/tools 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），负责注册全部标准工具域。
  entry: ['src/index.ts'],
  // core 与标准 tools-* 域包都在 dependencies，tsup 自动 external；MCP 独立装配。
  external: [],
})
