// @einfach-agent/core 的构建入口——共享口径全在根 tsup.preset.ts 里，这里只写 core 独有的两件事：
// ① 九条公开 subpath 的 entry 清单；② 多 entry 共享单例必须开的 splitting。
import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  // entry 用对象形态而不是数组：key 就是 dist 里的产物路径（不带扩展名），与 package.json 的
  // exports 逐条死锁。数组形态要靠 tsup 推断公共前缀，多一层目录就会整体位移。
  //
  // 这九条 = core 的公开面白名单（`scripts/check-boundaries.js` 的 coreSubpathAllowList，
  // 顺序与之对齐）。**加 entry 前先过那份白名单**：白名单没有的 subpath 不该有 entry，
  // 它们仍走 exports 里的 `./*` 通配。
  entry: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    timeline: 'src/timeline.ts',
    'tools/index': 'src/tools/index.ts',
    'subagents/index': 'src/subagents/index.ts',
    'state/persistence/index': 'src/state/persistence/index.ts',
    'observability/index': 'src/observability/index.ts',
    'skills/index': 'src/skills/index.ts',
    'planning/index': 'src/planning/index.ts',
  },
  // 必须开：core 是多 entry 包，且这些 entry 共享模块级可变单例（rootStore、defaultCore、
  // atom 家族）。关着 splitting 时每条 entry 会各自内联一份，消费方同时 import 两条 subpath
  // 就会拿到两个互不可见的 store —— 详见 tsup.preset.ts 的 splitting 注释。
  splitting: true,
  // 四个运行时依赖里，@einfach-agent/ai 与 @einfach/core 在本包 dependencies，
  // @tauri-apps/api 与 @tauri-apps/plugin-dialog 是 optional peerDependencies（D6）——
  // tsup 的自动 external 同时覆盖 dependencies + peerDependencies，且按包名前缀匹配，
  // `@tauri-apps/api/core` 这种子路径形态一并覆盖，故这里留空。
  // 降 optional peer 后仍成立已实测：dist 里两处动态 import 保持裸说明符、零内联。
  external: [],
})
