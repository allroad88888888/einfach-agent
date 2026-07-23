// tools/registry.ts —— 工具注册表的【模块单例视图】（实例化 · 第 1 期）。
// ---------------------------------------------------------------------------
// 原本这里既定义抽象工厂 createToolRegistry，又建模块单例 toolRegistry。第 1 期起：
//   · 工厂定义（createToolRegistry / ToolRegistry 接口）迁到叶子模块 tools/toolRegistry.ts
//     （破环：coreInstance 要用工厂，但不能 import 回本文件——本文件要 import defaultCore）；
//   · 本文件保留【同名导出】——re-export 工厂 + 把模块单例 toolRegistry 指向 defaultCore.tools。
// 所以全仓 `import { toolRegistry / createToolRegistry } from './registry'` 一行不用改：
//   · createToolRegistry / ToolRegistry：透传自 tools/toolRegistry.ts；
//   · toolRegistry：现在【就是】defaultCore.tools（createCoreInstance 时已注册好标准工具）。
import { defaultCore } from '../runtime/core/coreInstance'

// 抽象工厂 + 接口：原样 re-export，测试与 createCore 都从这里（或 toolRegistry.ts）取。
export { createToolRegistry } from './toolRegistry'
export type { ToolRegistry } from './toolRegistry'

/** 模块级单例：= 默认实例的工具注册表。标准工具已在 createCoreInstance 时注册进它。 */
export const toolRegistry = defaultCore.tools
