// @web-agent/server 的构建入口——共享口径全在根 tsup.preset.ts 里。
//
// 本包与 packages/* 的发布包不同：它不是被 import 的库，是被 `node`/bin 直接执行的进程
// （见 D2），没有消费方要拿它的 .d.ts 或 subpath exports，所以只用 tsup 出单文件 JS，
// **不接 `tsc -p tsconfig.build.json --emitDeclarationOnly`**（那一步是为公开 exports 面
// 服务的，本包没有）。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // 单 entry：main.ts 是唯一的执行入口，splitting 关着（默认值）→ tsup 把 mainRunServer /
  // createServer / requestRouter 等相对 import 全部内联进一个文件。这一点被
  // `createServer.ts` 的 `resolveDefaultDistDirectory()` 依赖：内联后模块内的
  // `import.meta.url` 统一指向这份产物自己（`dist/main.js`），而不是各自的源文件路径。
  entry: ['src/main.ts'],
  // @web-agent/core、@web-agent/host-node 已在本包 package.json 的 dependencies 里，
  // tsup 按 getProductionDeps 自动 external，这里留空。
  external: [],
})
