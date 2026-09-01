// @einfach-agent/tools —— 标准工具集的【meta 聚合包】（TSPLIT TS2）。
// ---------------------------------------------------------------------------
// 【登记反转后的 batteries-included 落点】core（@einfach-agent/core）现在无主张、不硬编码任何工具；
// 那 36 个具体工具按能力域拆进 7 个 @einfach-agent/tools-* 包。本 meta 包把它们重新聚合：
//   · re-export 各域的工具对象 + register<Domain>Tools；
//   · 提供 registerStandardTools —— 一把装齐全部 7 域 36 工具，等价于旧的 tools/register.ts。
// 消费方（app 的 main.tsx / 测试的 test/setup.ts）import 本包、对 core 的某个 registry 调一次
//   registerStandardTools 即恢复"默认工具集"。想要精简工具集的嵌入方，可只 import 某几个域包、
//   各自 register<Domain>Tools —— core 不再把工具焊死，装什么由消费层拼装。
//
// 依赖方向：tools（meta）→ tools-*（域）→ core（抽象 + 特性）。core 不反向依赖任何 tools 包 —— 单向无环。

import type { ToolRegistry } from '@einfach-agent/core/tools'
import { registerShellTools } from '@einfach-agent/tools-shell'
import { registerInteractionTools } from '@einfach-agent/tools-interaction'
import { registerVisionTools } from '@einfach-agent/tools-vision'
import { registerFsTools } from '@einfach-agent/tools-fs'
import { registerPlanningTools } from '@einfach-agent/tools-planning'
import { registerSkillsTools } from '@einfach-agent/tools-skills'
import { registerAgentsTools } from '@einfach-agent/tools-agents'

// re-export 七个域包的全部导出（工具对象 + 各自的 register<Domain>Tools），供按域精装的消费方直接取用。
export * from '@einfach-agent/tools-shell'
export * from '@einfach-agent/tools-interaction'
export * from '@einfach-agent/tools-vision'
export * from '@einfach-agent/tools-fs'
export * from '@einfach-agent/tools-planning'
export * from '@einfach-agent/tools-skills'
export * from '@einfach-agent/tools-agents'

/**
 * 装齐全部 7 域 36 个标准工具（batteries-included）。幂等（各 register 内部同名覆盖）。
 * 注册顺序按域：shell → interaction → vision → fs → planning → skills → agents。
 * 工具按 name 查找，故域内/域间顺序不影响功能。
 */
export function registerStandardTools(registry: ToolRegistry): void {
  registerShellTools(registry)
  registerInteractionTools(registry)
  registerVisionTools(registry)
  registerFsTools(registry)
  registerPlanningTools(registry)
  registerSkillsTools(registry)
  registerAgentsTools(registry)
}
