// @web-agent/persistence-idb 的构建入口——共享口径全在根 tsup.preset.ts 里。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 本包只对外暴露一个 barrel（src/index.ts），exports 也只有 `.` 一条，故单 entry。
  entry: ['src/index.ts'],
  // 唯一运行时依赖 @web-agent/core 已在本包 dependencies，tsup 自动 external；IndexedDB 是
  // 浏览器原生 API，源码不引入第三方包（fake-indexeddb 只在测试文件里出现，不进构建入口图）。
  external: [],
})
