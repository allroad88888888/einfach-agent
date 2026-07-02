// 多轮 tool 循环的纯函数 helper（组 system / 组 tools / 解析响应）—— 无副作用、无 store。
// ---------------------------------------------------------------------------
// 从 modelRun 里抽出的三件事，方便单测与复用：
//   · buildSystemItem —— 组本轮 system 指令（TK4：只放已加载 skill 名，skill 内容不进 prompt）。
//   · buildTurnTools  —— 组本轮暴露给 model 的 function 列表（TK3：request_tool_schema
//     恒在场 + 已懒加载的 visible tools；未加载的工具永不进 tools）。
//   · narrowToolCalls / safeParseArgs —— 把宽松响应收窄成请求侧必填形状、安全解析参数。

import { pickSkillsForInput } from '../skills/registry'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool } from '../tools/types'
import type {
  ModelFunctionTool,
  ModelResponseToolCall,
  ModelToolCall,
  SystemItem,
} from '../api/modelApi'
import { newId } from './newId'

// 简介：组本轮 system 指令（不 appendItem，只用于请求）。
// 详情（TK4）：按触发词选 skill（总含 web-chat-agent），system 只写「已加载 skills：<names>」；
// skill 正文不进 prompt —— model 要读内容必须调 skill_read。同时告知 lazy tools 协议。
export function buildSystemItem(input: string): SystemItem {
  const skillNames = pickSkillsForInput(input)
    .map((skill) => skill.name)
    .join('、')

  const content = [
    '你运行在支持 lazy tools 的 Web Agent Runtime 中，可以像普通 assistant 一样直接回复用户，也可以调用工具。',
    '“工具清单”只是可用能力名称，未加载 schema 的工具不能直接调用；需要某个能力时，先调用 request_tool_schema 选择工具名并说明原因，加载后再调用。',
    '不要在普通文本里模拟工具调用或工具结果；工具名必须来自工具清单。',
    `已加载 skills：${skillNames}`,
    'skill 正文不在此展示；需要其内容时调用 skill_read 读取。',
  ].join('\n')

  return { role: 'system', content }
}

// 简介：组本轮暴露给 model 的 function 列表（TK3）。
// 详情：request_tool_schema 恒在场（enum 为全部工具名，供 model 请求懒加载）；其后跟上本轮
// 已加载 schema 的 visible tools（各自展开 name/description/inputSchema）。未加载的工具不进。
export function buildTurnTools(visible: LoadedTool[]): ModelFunctionTool[] {
  return [
    requestSchemaTool(),
    ...visible.map((tool) => ({
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
function requestSchemaTool(): ModelFunctionTool {
  return {
    type: 'function',
    function: {
      name: 'request_tool_schema',
      description: 'Lazy-load the JSON schema for one available tool so it becomes callable this run.',
      parameters: {
        type: 'object',
        properties: {
          toolName: { type: 'string', enum: toolRegistry.list().map((tool) => tool.name) },
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

// 简介：安全解析 tool_call 的 arguments 字符串为参数对象。
// 详情：空串 / 非法 JSON / 非对象（数组、标量）一律降级为空对象 {}，绝不抛。
export function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
