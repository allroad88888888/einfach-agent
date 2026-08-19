// @einfach-agent/tools-mcp 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts）。
  entry: ['src/index.ts'],
  // @modelcontextprotocol/sdk、@einfach-agent/core、zod 都在本包 dependencies，tsup 自动
  // external；SDK 的深子路径（`@modelcontextprotocol/sdk/client/index.js` 等）按包名前缀
  // 一并覆盖。
  external: [],
})
