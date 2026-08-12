// runtime/core/createCore.ts —— 「实例化」第 3 期收口：组装「隔离实例 + 绑定它的命令集」。
// ---------------------------------------------------------------------------
// createCore(opts?) = createCoreInstance(opts) 造一套隔离的 store/registry/abort/config，再
//   createCommands(instance) 造一组【只在这套实例上跑】的命令，合体返回 CoreInstance & CommandApi。
//   于是 createCore().sendMessage(...) 就在它自己的 store/registry/abort/config 上跑，与 defaultCore
//   完全隔离 —— 这是「能嵌两次」的收口证明（见 createCore.test.ts）。opts.config 预置 apiKey 等，
//   隔离实例的命令读自己的 core.config（不经 configureCommands，那个专写 defaultCore.config）。
//
// 【为何单独成文件、不放进 coreInstance.ts】coreInstance.ts 的架构不变量是「叶子模块」：只 import
//   createStore / createToolRegistry / registerStandardTools，【绝不】import 任何视图/上层模块，构成
//   单向依赖「视图 → coreInstance」无环（见 coreInstance.ts 顶部注释）。而 createCore 要 import
//   commands.ts（上层：commands.ts 又 import modelRun/coreInstance 等），若塞进 coreInstance.ts 就成了
//   coreInstance → commands → coreInstance 的反向边，破坏该不变量、且有 init 期环风险。故 createCore
//   独立成【顶层组合模块】：createCore.ts → coreInstance.ts + commands.ts；两者都不 import 本文件，
//   本文件是叶子消费方，无环。
//
// 【仍待收口的多实例边界】主模型循环、工具懒加载和会话级危险工具授权已经显式使用当前 core；
//   Planning getter/writer、持久化 bridge，以及 subagent runtime 内的工具 registry/权限调用仍有
//   defaultCore 兼容路径。createCore 已适合隔离普通会话与主循环，但不能宣称这三条扩展路径完全隔离。

import {
  createCoreInstance,
  type CoreInstance,
  type ProjectSkillsProvider,
  type RuntimeConfig,
} from './coreInstance'
import type { ToolRegistry } from '../../tools/toolRegistry'
import type { SkillsRegistry } from '../../skills/contracts'
import { createCommands, type CommandApi } from '../commands'
import { createPluginCommandFacade } from './pluginCommandFacade'
import type { PluginInput } from './pluginHost'

// 简介：造一套隔离的 CoreInstance 并把绑定它的命令挂上去，合体返回。
// 详情：命令用 createCommands(instance) 绑到 instance 本体，再 Object.assign 把这些命令方法挂回
//   instance ——【故返回对象 === 命令闭包里那个 core】，命令派给 runSession/runToolLoop 的 core 就是
//   这个返回对象本身（不是它的浅拷贝），身份自洽。instance 与 commands 无字段名冲突（CoreInstance:
//   rootStore/getSessionStore/tools/abort/config…；CommandApi: sendMessage/newSession/…），故 assign
//   不会覆盖任何实例字段。想分开引用两半时解构返回值即可。
export function createCore(opts?: {
  config?: Partial<RuntimeConfig>
  // 登记反转（TS1）：把工具装进这个隔离实例的私有 registry；透传给 createCoreInstance。
  // 不传则该实例【无工具】——嵌入方按需 registerStandardTools(core.tools) 或装自定义工具集。
  registerTools?: (registry: ToolRegistry) => void
  /** Installed only on this Core; built-in loop plugins remain enabled. */
  plugins?: readonly PluginInput[]
  /** 项目 Skills 扫描由装配层注入；未传时该实例固定使用空快照。 */
  projectSkillsProvider?: ProjectSkillsProvider
  /** 内置 skill registry 由 tools-skills 装配；未传时使用空实现。 */
  skillRegistry?: SkillsRegistry
}): CoreInstance & CommandApi {
  const instance = createCoreInstance(opts)
  const commands = createCommands(instance)
  instance.plugins.bindCommandFacade(createPluginCommandFacade(commands))
  return Object.assign(instance, commands)
}
