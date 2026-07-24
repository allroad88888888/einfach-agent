// 多轮 tool 循环的纯函数 helper（组 system / 组 tools / 解析响应）—— 无副作用、无 store。
// ---------------------------------------------------------------------------
// 从 modelRun 里抽出的三件事，方便单测与复用：
//   · buildSystemItem / buildSkillContextItem —— 固定运行时协议放请求首部，按输入变化的
//     skill 名放历史尾部；skill 内容仍不进 prompt。
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
  ModelItem,
  ModelResponseToolCall,
  ModelToolCall,
  SystemItem,
} from '@web-agent/ai'
import { newId } from './newId'

// 简介：组固定的运行时 system 指令（不 appendItem，只用于请求）。
// 详情：这里不能混入本轮输入、时间或计划状态，否则每轮都会从 token 0 打断 Provider 的前缀缓存。
export function buildSystemItem(): SystemItem {
  const content = [
    '你运行在支持 lazy tools 的本地桌面 Agent Runtime 中，可以像普通 assistant 一样直接回复用户，也可以调用本机与工作区工具。',
    '“工具清单”只是可发现的能力名称，不代表其参数 schema 已加载。除 request_tool_schema 外，只能调用当前请求中实际提供了完整 schema 的工具；需要其它能力时，必须先调用 request_tool_schema，读取返回的参数名与约束后再调用，禁止凭工具名猜参数。',
    '不要在普通文本里模拟工具调用或工具结果；工具名必须来自工具清单。',
    'skill 正文不在此展示；需要其内容时，先用 request_tool_schema 加载 skill_read，再严格按返回 schema 调用 skill_read。',
    '复杂、分阶段或执行中升级为多阶段的任务，应先按 lazy-tool 协议读取 planning skill，再按其中说明加载并使用 create_plan → execute_plan → submit_stage_result；submit_stage_result 会触发独立 evaluator，update_plan 只处理阻塞或跳过，不要自行判定完成。',
    '需要审批的计划只能由宿主界面批准，模型不得自行批准或绕过 execute_plan。',
  ].join('\n')

  return { role: 'system', content }
}

// 简介：组本轮动态 skill 提示。
// 详情（TK4）：只列按输入匹配到的 skill 名，正文仍须经 skill_read 读取。调用方把它放到
// append-only 历史之后，避免本轮变化污染固定 system + 已有对话的可缓存前缀。
export function buildSkillContextItem(input: string): SystemItem {
  const skillNames = pickSkillsForInput(input)
    .map((skill) => skill.name)
    .sort(compareStableText)
    .join('、')

  return {
    role: 'system',
    content: `已匹配、但正文尚未读取的 skills：${skillNames}`,
  }
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

// 不用 localeCompare：它会受宿主 locale / ICU 实现影响，不适合决定可缓存请求前缀的字节顺序。
function compareStableText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // JSON Schema 数组的顺序可能有语义，也会影响模型看到的内容；只规范化数组元素里的对象。
    return value.map(canonicalizeJsonValue)
  }
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareStableText)
      .map((key) => [key, canonicalizeJsonValue(record[key])]),
  )
}

/**
 * 返回递归按键名排序的新 JSON Schema，不修改注册表持有的原对象。
 * 数组保持原顺序；只有对象键会规范化，以稳定跨轮次的 tools 请求前缀。
 */
export function canonicalizeJsonSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return canonicalizeJsonValue(schema) as Record<string, unknown>
}

function canonicalTool(tool: ModelFunctionTool): ModelFunctionTool {
  return {
    type: tool.type,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: canonicalizeJsonValue(tool.function.parameters),
    },
  }
}

function compareCanonicalTools(
  left: { name: string; serialized: string },
  right: { name: string; serialized: string },
): number {
  const leftRank = left.name === 'request_tool_schema' ? 0 : 1
  const rightRank = right.name === 'request_tool_schema' ? 0 : 1
  return leftRank - rightRank
    || compareStableText(left.name, right.name)
    || compareStableText(left.serialized, right.serialized)
}

// FNV-1a 32-bit：同步、无副作用且只依赖浏览器已有的 Math.imul。
// 这是缓存身份提示而非安全签名；版本前缀允许未来替换算法或规范化规则。
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 为完整 tool-set（名称、描述和 schema）生成与输入排列无关的稳定 fingerprint。
 * request_tool_schema 与 buildTurnTools 一样固定排在第一，其余按名称排序。
 */
export function toolSetSchemaFingerprint(tools: readonly ModelFunctionTool[]): string {
  const entries = tools
    .map((tool) => {
      const canonical = canonicalTool(tool)
      return {
        name: canonical.function.name,
        serialized: JSON.stringify(canonical),
      }
    })
    .sort(compareCanonicalTools)

  const canonicalToolSet = `[${entries.map((entry) => entry.serialized).join(',')}]`
  return `tools-v1-fnv1a32-${fnv1a32(canonicalToolSet)}`
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
      .sort((left, right) => compareStableText(left.name, right.name))
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: [tool.description, tool.guide].filter(Boolean).join('\n\n'),
          parameters: canonicalizeJsonSchema(tool.inputSchema),
        },
      })),
  ]
}

// request_tool_schema 元工具：让 model 请求 runtime 懒加载某个工具的完整 JSON Schema。
// enum 按环境过滤掉 server 工具（TP3）——web 下 model 根本请求不到必然失败的 Tauri 工具。
function requestSchemaTool(isTauri: boolean, options?: BuildTurnToolsOptions): ModelFunctionTool {
  const toolNames = (options?.registry ?? toolRegistry)
    .list()
    .filter((tool) => isToolVisible(tool.runtime, isTauri) && isToolAllowed(tool.name, options))
    .map((tool) => tool.name)
    .sort(compareStableText)

  return {
    type: 'function',
    function: {
      name: 'request_tool_schema',
      description: 'Lazy-load the JSON schema for one available tool so it becomes callable this run.',
      parameters: canonicalizeJsonSchema({
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            // 读绑定 core 的 registry（缺省回落模块级 toolRegistry＝defaultCore.tools）——见 [P1] 注释。
            enum: toolNames,
          },
          reason: { type: 'string' },
        },
        required: ['toolName', 'reason'],
      }),
    },
  }
}

function parsedObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function loadedToolName(content: string, requestedToolName: string): string | undefined {
  const result = parsedObject(content)
  if (!result) return undefined

  const resultToolName = result.loaded === true && typeof result.toolName === 'string'
    ? result.toolName
    : typeof result.name === 'string'
        && Object.prototype.hasOwnProperty.call(result, 'inputSchema')
      ? result.name
      : undefined

  return resultToolName === requestedToolName ? resultToolName : undefined
}

// 简介：从历史 request_tool_schema call/result 恢复已成功加载的工具名。
// 详情：只读取历史、不改写发给模型的 messages。调用方应从当前 registry 重新取得最新 schema，
// 放入请求顶层 tools；原始 loader call/result 继续进入模型请求，保持缓存前缀与执行因果。
export function loadedToolNamesFromHistory(messages: readonly ModelItem[]): string[] {
  const requestedByCallId = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.function.name !== 'request_tool_schema') continue
        const parsed = parseToolCallArgs(toolCall.function.arguments)
        const toolName = parsed.ok && typeof parsed.args.toolName === 'string'
          ? parsed.args.toolName
          : undefined
        if (toolName) requestedByCallId.set(toolCall.id, toolName)
      }
    }
  }

  const loadedToolNames = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const requestedToolName = requestedByCallId.get(message.tool_call_id)
    if (!requestedToolName) continue
    const loaded = loadedToolName(message.content, requestedToolName)
    if (!loaded) continue
    loadedToolNames.add(loaded)
  }
  return [...loadedToolNames]
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
