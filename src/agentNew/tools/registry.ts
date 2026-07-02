// tools/registry.ts —— 抽象工厂 ToolRegistry（见 TOOLS-SPEC.md §3/§4）。
//
// 职责三件：① 注册（register，幂等/后注册覆盖）；② 懒加载 schema（loadSchema，TK3）；
// ③ 统一分发执行（run，§4 生命周期）。运行时只依赖本工厂接口，不依赖任何具体 Tool。
//
// 边界：registry 只做「注册/查/合成/执行 + 错误封装」——
//   · 不 append 任何 timeline/message，不判 ghost/stale（那是 modelRun 循环的事，§4）；
//   · 唯一副作用面是各工具拿到的 ctx，registry 只负责把 ctx 原样透传给 execute。
// 类型全部来自 ./types，本文件不再就地定义（与旧移植版的关键差异）。

import type { Tool, ToolContext, ToolResult, ToolSummary, LoadedTool } from './types'

/** 抽象工厂接口：注册 + 懒加载 + 统一分发。运行时依赖它，不依赖具体 Tool（§3）。 */
export interface ToolRegistry {
  register(tool: Tool): void
  has(name: string): boolean
  list(): ToolSummary[]
  loadSchema(name: string): LoadedTool | undefined
  run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 建一个 ToolRegistry。内部一张 Map<name, Tool>：
 *   · register 幂等——同名后注册直接覆盖，不报错；
 *   · list() 只摘 name/description(=skill.description)/runtime，绝不含 inputSchema/guide（manifest-only）；
 *   · loadSchema(name) 在 summary 之上补 inputSchema + guide(=skill.content)，未知名 → undefined；
 *   · run(name,args,ctx) 走 §4 生命周期（见方法内注释）。
 */
export function createToolRegistry(): ToolRegistry {
  // 注册表：以 tool.name 为键。Map.set 天然「后写覆盖」→ register 幂等。
  const tools = new Map<string, Tool>()

  return {
    register(tool) {
      // 幂等：同名后注册胜，直接覆盖。
      tools.set(tool.name, tool)
    },

    has(name) {
      return tools.has(name)
    },

    list() {
      // manifest-only（TK3）：只暴露 name/description/runtime，绝不含 inputSchema/guide。
      // description 取自 tool.skill.description（一句话，terse）。
      return Array.from(tools.values(), (tool) => ({
        name: tool.name,
        description: tool.skill.description,
        runtime: tool.runtime,
      }))
    },

    loadSchema(name) {
      // 懒加载：未知名 → undefined；否则在 summary 之上补 inputSchema + guide(=skill.content)。
      // guide 与 schema 一起随 request_tool_schema 给 model，不进 manifest（§6）。
      const tool = tools.get(name)
      if (!tool) return undefined
      return {
        name: tool.name,
        description: tool.skill.description,
        runtime: tool.runtime,
        inputSchema: tool.inputSchema,
        guide: tool.skill.content,
      }
    },

    async run(name, args, ctx) {
      // §4 执行生命周期（守卫/错误封装集中在这里，execute 只写纯逻辑）：
      // 1) has(name) 为假 → { ok:false, error:'unknown tool: <name>' }，不抛。
      const tool = tools.get(name)
      if (!tool) {
        return { ok: false, error: `unknown tool: ${name}` }
      }
      // 2) await execute（同步/异步无差别，工厂 await 吸收），包 try/catch。
      try {
        return await tool.execute(args, ctx)
      } catch (err) {
        // AbortError → 透传 rethrow：交给上层 run 状态机降级为 stopped（与现有 toolExecution 一致）。
        if (err instanceof Error && err.name === 'AbortError') {
          throw err
        }
        // 其它异常 → 封成 error result（TK6：工具抛错不打断循环）。
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

/** 模块级单例：运行时统一从这里注册（defs/index.ts）/分发（modelRun）工具。 */
export const toolRegistry = createToolRegistry()
