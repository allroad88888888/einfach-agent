// 多轮 tool 循环的纯函数 helper（组 system / 组 tools / 解析响应）—— 无副作用、无 store。
// ---------------------------------------------------------------------------
// 从 modelRun 里抽出的三件事，方便单测与复用：
//   · buildSystemItem —— 组本轮 system 指令（TK4：只放已加载 skill 名，skill 内容不进 prompt）。
//   · buildTurnTools  —— 组本轮暴露给 model 的 function 列表（TK3：request_tool_schema
//     恒在场 + 已懒加载的 visible tools；未加载的工具永不进 tools）。
//   · narrowToolCalls —— 把宽松响应收窄成请求侧必填形状。
//   · parseToolCallArgs —— 判别联合版的参数解析（区分「没传参」与「传了坏 JSON」），
//     主循环（modelRun）与子 agent 循环（subagents/runtime）共用同一份判据。

import { pickSkillsForInput } from '../skills/registry'
import { toolRegistry } from '../tools/registry'
import type { ToolRegistry } from '../tools/toolRegistry'
import type { LoadedTool, ToolRuntime } from '../tools/types'
import type {
  ModelFunctionTool,
  ModelResponseToolCall,
  ModelToolCall,
  SystemItem,
} from '@web-agent/ai'
import { newId } from './newId'

// 简介：组本轮 system 指令（不 appendItem，只用于请求）。
// 详情（TK4）：按触发词选 skill（总含 web-chat-agent），system 只写「已加载 skills：<names>」；
// skill 正文不进 prompt —— model 要读内容必须调 skill_read。同时告知 lazy tools 协议。
export function buildSystemItem(input: string): SystemItem {
  const skillNames = pickSkillsForInput(input)
    .map((skill) => skill.name)
    .join('、')

  const content = [
    '你运行在支持 lazy tools 的本地桌面 Agent Runtime 中，可以像普通 assistant 一样直接回复用户，也可以调用本机与工作区工具。',
    '“工具清单”只是可用能力名称，未加载 schema 的工具不能直接调用；需要某个能力时，先调用 request_tool_schema 选择工具名并说明原因，加载后再调用。',
    '不要在普通文本里模拟工具调用或工具结果；工具名必须来自工具清单。',
    `已加载 skills：${skillNames}`,
    'skill 正文不在此展示；需要其内容时调用 skill_read 读取。',
    '复杂、分阶段或执行中升级为多阶段的任务，应读取 planning skill，并使用 create_plan → execute_plan → submit_stage_result 协议；submit_stage_result 会触发独立 evaluator，update_plan 只处理阻塞或跳过，不要自行判定完成。',
    '需要审批的计划只能由宿主界面批准，模型不得自行批准或绕过 execute_plan。',
  ].join('\n')

  return { role: 'system', content }
}

// TP3 判据：server 工具依赖 Tauri 本机能力（shell/文件系统），web 下不可用 → 不暴露给 model。
// enum 与 visible 展开共用此谓词，保证「能请求的」与「能看见的」判据一致。
interface BuildTurnToolsOptions {
  allowedToolNames?: readonly string[]
  // 【登记反转 · TS1 收口】request_tool_schema 的 enum 枚举「本实例可懒加载的全部工具」，必须读【绑定 core
  //   的 registry】而非模块级 toolRegistry（＝ defaultCore.tools）。否则 createCore({registerTools}) 造的
  //   隔离实例装了自定义工具集时，manifest 会广播 defaultCore 的工具、漏掉本实例的工具 —— 模型看得见错的、
  //   看不见对的。缺省回落 toolRegistry（defaultCore 路径行为零变化）。见 codex review [P1]。
  registry?: ToolRegistry
}

function isToolAllowed(name: string, options?: BuildTurnToolsOptions): boolean {
  return !options?.allowedToolNames || options.allowedToolNames.includes(name)
}

function isToolVisible(runtime: ToolRuntime, isTauri: boolean): boolean {
  return runtime !== 'server' || isTauri
}

// 简介：组本轮暴露给 model 的 function 列表（TK3 + TP3）。
// 详情：request_tool_schema 恒在场（enum 为当前环境可用的工具名，供 model 请求懒加载）；其后跟上
// 本轮已加载 schema 的 visible tools（各自展开 name/description/inputSchema）。未加载的工具不进；
// server 工具在 web 下（isTauri=false）既不入 enum 也不入 visible（TP3，防御 web 混入的 server 工具）。
export function buildTurnTools(
  visible: LoadedTool[],
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): ModelFunctionTool[] {
  return [
    requestSchemaTool(isTauri, options),
    ...visible
      .filter((tool) => isToolVisible(tool.runtime, isTauri) && isToolAllowed(tool.name, options))
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
  ]
}

// request_tool_schema 元工具：让 model 请求 runtime 懒加载某个工具的完整 JSON Schema。
// enum 按环境过滤掉 server 工具（TP3）——web 下 model 根本请求不到必然失败的 Tauri 工具。
function requestSchemaTool(isTauri: boolean, options?: BuildTurnToolsOptions): ModelFunctionTool {
  return {
    type: 'function',
    function: {
      name: 'request_tool_schema',
      description: 'Lazy-load the JSON schema for one available tool so it becomes callable this run.',
      parameters: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            // 读绑定 core 的 registry（缺省回落模块级 toolRegistry＝defaultCore.tools）——见 [P1] 注释。
            enum: (options?.registry ?? toolRegistry)
              .list()
              .filter((tool) => isToolVisible(tool.runtime, isTauri) && isToolAllowed(tool.name, options))
              .map((tool) => tool.name),
          },
          reason: { type: 'string' },
        },
        required: ['toolName', 'reason'],
      },
    },
  }
}

// 简介：把响应里的宽松 tool_calls 收窄成请求侧必填的 ModelToolCall[]。
// 详情：丢弃缺 function.name 的项（无从分发）；id 缺失时自造一个稳定 id —— 同一份收窄结果既
// 用于 appendItem assistant.tool_calls、也用于逐个产出 ToolItem.tool_call_id，二者天然一致。
export function narrowToolCalls(raw: ModelResponseToolCall[] | undefined): ModelToolCall[] {
  if (!raw) return []
  return raw
    .filter((toolCall) => toolCall.function?.name)
    .map((toolCall) => ({
      id: toolCall.id ?? newId(),
      type: 'function' as const,
      function: {
        name: toolCall.function!.name!,
        arguments: toolCall.function!.arguments ?? '',
      },
    }))
}

// ---------------------------------------------------------------------------
// tool_call 参数解析（区分「没传参」与「传了坏 JSON」）
// ---------------------------------------------------------------------------
// 历史：这里曾有一个 safeParseArgs，把「空串」「非法 JSON」「非对象」一律降级成 {}，于是被
// finish_reason='length' 截断的半截 arguments 会被当成「模型就是不传参」而照常执行工具 ——
// 拿默认参数干活比直接报错危险得多，且是最难查的一类故障。现在两者分开：解析失败的 tool_call
// 不执行，改回填一条错误 tool 结果让 model 自己重发。safeParseArgs 已随两条循环迁移完毕而删除。
// ★ 主 agent 循环（modelRun）与子 agent 循环（subagents/runtime）共用这一份判据 ★ ——
//   任何一边另起一套宽松解析，那条循环就会重新开始静默吞坏 JSON。
export type ToolArgsParse =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; args: Record<string, unknown>; error: string; raw: string }

function parseErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function parsedValueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// 简介：把 tool_call 的 arguments 字符串解析成判别联合（成功 / 失败带原因+原文）。
// 详情：空串（或纯空白）视为无参工具的合法形态 → { ok:true, args:{} }；
//   非法 JSON / 合法 JSON 但不是对象（数组、标量、null）→ { ok:false }，附中文原因与 trim 后的原文。
//   永不抛。
export function parseToolCallArgs(raw: string | undefined): ToolArgsParse {
  const text = typeof raw === 'string' ? raw.trim() : ''
  // 空 arguments 是无参工具的合法形态，不算失败。
  if (!text) return { ok: true, args: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      args: {},
      error: `工具参数不是合法 JSON（可能被截断）：${parseErrorMessage(err)}`,
      raw: text,
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, args: parsed as Record<string, unknown> }
  }
  return {
    ok: false,
    args: {},
    error: `工具参数必须是 JSON 对象，实际收到 ${parsedValueKind(parsed)}`,
    raw: text,
  }
}
