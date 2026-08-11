// 多轮 tool 循环的纯函数 helper（组 system / 组 tools / 解析响应）—— 无副作用、无 store。
// ---------------------------------------------------------------------------
// 从 modelRun 里抽出的三件事，方便单测与复用：
//   · buildSystemItem / buildCustomInstructionsItem —— 固定运行时协议与长期自定义指令，都放在
//     append-only 历史【之前】的稳定前缀里，不含本轮输入。
//     ★ skill 名单不再由本文件产出 ★（阶段 3，docs/skills-tree-blueprint.md）：曾经的
//     buildSkillContextItem 按本轮输入匹配 skill、把名单挂在历史尾部，导致每轮都被新历史顶位、
//     全额 cache miss。现在改为 registry 的 buildSkillManifestText() 产出【全量】清单，
//     与固定 system 同区进稳定前缀，由模型按 description 自判该读哪个；
//     TK4 不变——进 prompt 的只有清单元数据，正文与资源仍必须经 skill_read。
//   · buildEnvironmentItem —— 组「运行环境」段（workspace 根目录 / 宿主 / 平台 + 路径纪律）。
//     它是稳定前缀里唯一按会话变化的一段，故排在其它前缀段【之后】。
//   · buildToolManifestText —— 组当前环境下的全量工具摘要（仅 name/description/runtime），
//     让 model 首轮即可发现精确工具名；不含 schema/guide。
//   · buildTurnTools  —— 组本轮暴露给 model 的 function 列表（TK3：request_tool_schema
//     恒在场 + 已懒加载的 visible tools；未加载的工具永不进 tools）。
//   · narrowToolCalls —— 把宽松响应收窄成请求侧必填形状。
//   · parseToolCallArgs —— 判别联合版的参数解析（区分「没传参」与「传了坏 JSON」），
//     主循环（modelRun）与子 agent 循环（subagents/runtime）共用同一份判据。

import { toolRegistry } from '../tools/registry'
import type { ToolCatalog } from '../tools/toolCatalog'
import type { LoadedTool, ShellPlatform, ToolRuntime, ToolSummary } from '../tools/types'
import {
  maxTurnToolsForVendor,
  type ModelFunctionTool,
  type ModelItem,
  type ModelResponseToolCall,
  type ModelToolCall,
  type SystemItem,
} from '@web-agent/ai'
import { TOOL_SCHEMA_AUTOLOADED_CODE } from '../tools/schemaResult'
import { newId } from './newId'
// 收尾自查 / 如实报告两条条款住在零依赖叶子模块：evals 的 prompt 行为 A/B 要 import 同一份
// 字节做对照实验，而本文件（经 skills/registry 的 .md?raw + tools/registry 的 defaultCore）
// 在那个 tsconfig 下既无法解析也不该被实例化。详见 selfReflectionPrompts.ts 顶部说明。
import { SELF_CHECK_CLAUSES } from './selfReflectionPrompts'
import { fnv1a32 } from './shared/hash'

// 简介：组固定的运行时 system 指令（不 appendItem，只用于请求）。
// 详情：这里不能混入本轮输入、时间或计划状态，否则每轮都会从 token 0 打断 Provider 的前缀缓存。
export function buildSystemItem(): SystemItem {
  const content = [
    '你运行在支持 lazy tools 的本地桌面 Agent Runtime 中，可以像普通 assistant 一样直接回复用户，也可以调用本机与工作区工具。',
    '“工具清单”只是可发现的能力名称，不代表其参数 schema 已加载。除 request_tool_schema 外，只能调用当前请求中实际提供了完整 schema 的工具；需要其它能力时，若已知精确名称就传 toolName 加载，未知名称则省略 toolName 并用 query/cursor/limit 分页发现，再调用 request_tool_schema 读取参数名与约束，禁止凭工具名猜参数。',
    '不要在普通文本里模拟工具调用或工具结果；工具名必须来自工具清单。',
    'skill 正文不在此展示；需要其内容时，先用 request_tool_schema 加载 skill_read，再严格按返回 schema 调用 skill_read。',
    '复杂、分阶段或执行中升级为多阶段的任务，应先按 lazy-tool 协议读取 planning skill，再按其中说明加载并使用 create_plan → execute_plan → submit_stage_result；submit_stage_result 会触发独立 evaluator，update_plan 只处理阻塞或跳过，不要自行判定完成。',
    '需要审批的计划只能由宿主界面批准，模型不得自行批准或绕过 execute_plan。',
    ...SELF_CHECK_CLAUSES,
  ].join('\n')

  return { role: 'system', content }
}

export interface EnvironmentItemInput {
  /** 该会话绑定的 workspace 根目录（已归一化）；未绑定时为 undefined。 */
  workspaceRoot?: string
  /** 宿主是否为 Tauri 桌面端：决定本机文件/shell 工具是否存在。 */
  isTauri: boolean
  /** 本机平台，取自 detectHostPlatform()（与 shell 桥实际收到的值同源）。 */
  platform: ShellPlatform
}

// 简介：组「运行环境」system 消息——告诉模型它在哪台机器、哪个工作区里干活。
// 详情：这是稳定前缀里【唯一按会话变化】的一段，因此调用方须把它排在其它前缀段之后
//   （见 modelRun 的 stablePrefix 注释）。内容只依赖会话绑定的 workspace 与宿主环境，
//   不含本轮输入、时间或计划状态，所以整个会话生命周期内逐字不变。
// ★ 为什么必须有这一段 ★ —— 缺它时模型对「我在哪」零信息，只能猜；实测 DeepSeek 首轮
//   直接编出一条训练数据里的绝对路径（/Users/<某人>/develop/...），read_file 报
//   WORKSPACE_READ_FAILED，模型是从【报错文案】里才第一次看到真实 workspace 根目录，
//   白烧三轮才走上正轨。把根目录摆进稳定前缀能整类消灭这种开局失败，且因为在前缀里、
//   逐字不变，token 成本被 provider 前缀缓存吃掉。
export function buildEnvironmentItem(input: EnvironmentItemInput): SystemItem {
  const lines = ['运行环境：']

  if (input.isTauri) {
    lines.push(`- 宿主：Tauri 桌面端（可用本机文件、shell 与 Git 工具）；本机平台 ${input.platform}。`)
    if (input.workspaceRoot) {
      lines.push(`- 当前工作区根目录：${input.workspaceRoot}`)
      lines.push('- 文件与 shell 工具的相对路径都以该根目录为基准；除非明确需要访问外部路径，优先传相对路径。')
    } else {
      // 没有根目录可报时不能造一个，也不能说"以该根目录为基准"——指代会落空。
      lines.push('- 当前会话未绑定工作区根目录：本机侧会自行推断（通常取 Git 根目录）。先用一次目录列举取得实际根目录，再据此组路径；此前一律传相对路径。')
    }
    // 反臆造条款：模型编路径时往往同时编出「项目是什么」，所以这里同时禁掉「按记忆假设内容」。
    lines.push('- 你对这个工作区里有什么文件【一无所知】。不要凭记忆或猜测写出本段未给出的绝对路径，也不要假设某个文件存在；先用目录列举或搜索类工具确认，再读写。')
  } else {
    lines.push(`- 宿主：浏览器（Web 预览）；本机平台 ${input.platform}。`)
    lines.push('- 本机文件、shell 与 Git 工具在本环境不可用，工具清单里也不会出现它们；不要声称自己读过或改过本机文件。')
  }

  return { role: 'system', content: lines.join('\n') }
}

// 简介：把宿主保存的长期自定义指令组成一条独立 system 消息。
// 详情：它与固定运行时协议分开成条（便于观测与替换），但由调用方放在【固定 system 之后、
//   append-only 历史之前】，与固定 system 一起构成本 lane 的稳定前缀。
// ★ 缓存权衡（曾经放在历史之后，实测每轮全额 miss）★ ——
//   自定义指令是低频变更的长期设置，却随着历史每轮增长被顶到新位置，于是每一轮都要为这段
//   token 付一次 cache miss。挪进稳定前缀后：不变的轮次（绝大多数）整段命中；用户真去设置里
//   改了指令的那一次，前缀字节变化会让 contextCache 记一次 profile_changed（新 epoch）、
//   provider 侧对应一次全量 miss —— 用「变更时的一次性代价」换「每一轮的持续命中」。
//   因此调用方须把本条内容并入 contextCache 的 systemContent，让变更被归因为 profile_changed，
//   而不是被误当成尾巴动态控制的变化。
export function buildCustomInstructionsItem(instructions: string): SystemItem | undefined {
  const normalized = instructions.trim()
  if (!normalized) return undefined
  return {
    role: 'system',
    content: `用户在设置中保存了以下长期自定义指令，请在本次任务中遵循：\n${normalized}`,
  }
}

// 每个 provider 的 function tools 容量由 @web-agent/ai 的 canonical vendor descriptor 提供。
// request_tool_schema 固定占一个槽位，maxTools 只能在该 provider 的上限内继续下调。
export const DEFAULT_TOOL_MANIFEST_PAGE_SIZE = 16
export const MAX_TOOL_MANIFEST_PAGE_SIZE = 32
export const MAX_TOOL_MANIFEST_QUERY_LENGTH = 128

// TP3 判据：server 工具依赖 Tauri 本机能力（shell/文件系统），web 下不可用 → 不暴露给 model。
// manifest 分页与 visible 展开共用此谓词，保证「能发现的」与「能看见的」判据一致。
export interface BuildTurnToolsOptions {
  allowedToolNames?: readonly string[]
  // 【登记反转 · TS1 收口】manifest 搜索必须读绑定 core 的 registry，而非模块级
  // toolRegistry（＝ defaultCore.tools）。缺省回落仅用于 defaultCore 路径。
  // 类型是只读的 ToolCatalog：run 会在这里塞自己的工具集 epoch，让发现面与注入的 manifest 同源。
  registry?: ToolCatalog
  /** 请求所用 provider；省略时使用保守 fallback descriptor。 */
  vendor?: string
  /** 请求顶层 tools 的总数预算；只能在 provider descriptor 上限内下调。 */
  maxTools?: number
  /**
   * 最近请求过 schema 的工具名，新 → 旧。
   * 它让一个已加载但被预算淘汰的旧工具在再次请求后立即回到工作集；最终线上顺序仍按名称排序。
   */
  recentToolNames?: readonly string[]
}

export interface ToolManifestSearchInput {
  query?: string
  cursor?: string
  limit?: number
}

export interface ToolManifestPage {
  kind: 'tool_manifest_page'
  query: string
  items: ToolSummary[]
  total: number
  limit: number
  hasMore: boolean
  nextCursor?: string
}

export interface ToolManifestError {
  kind: 'tool_manifest_error'
  code: 'invalid_cursor' | 'stale_cursor' | 'query_too_long'
  error: string
  restart: {
    query: string
    limit: number
  }
}

export type ToolManifestResult = ToolManifestPage | ToolManifestError

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

function normalizedMaxTurnTools(value: number | undefined, vendor: string | undefined): number {
  const maximum = maxTurnToolsForVendor(vendor ?? '')
  if (typeof value !== 'number' || !Number.isFinite(value)) return maximum
  return Math.max(1, Math.min(maximum, Math.floor(value)))
}

function normalizedManifestLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TOOL_MANIFEST_PAGE_SIZE
  }
  return Math.max(1, Math.min(MAX_TOOL_MANIFEST_PAGE_SIZE, Math.floor(value)))
}

function availableToolSummaries(
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): ToolSummary[] {
  return (options?.registry ?? toolRegistry)
    .list()
    .filter((tool) =>
      tool.name !== 'request_tool_schema'
      && isToolVisible(tool.runtime, isTauri)
      && isToolAllowed(tool.name, options))
    .sort((left, right) =>
      compareStableText(left.name, right.name)
      || compareStableText(left.description, right.description)
      || compareStableText(left.runtime, right.runtime))
}

/**
 * 生成当前环境可发现的全量工具摘要，供调用方放入稳定 system 前缀。
 *
 * 这里只包含 name/description/runtime；inputSchema、guide 仍只能经 request_tool_schema
 * 懒加载。description 折叠为空白稳定的单行，避免第三方工具的换行破坏清单边界。
 */
export function buildToolManifestText(
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): string {
  const tools = availableToolSummaries(isTauri, options)
  const lines = tools.map((tool) => {
    const description = tool.description.replace(/\s+/g, ' ').trim()
    return `· ${tool.name} [${tool.runtime}] — ${description}`
  })

  return [
    '可用工具摘要（当前环境；仅用于发现，不代表参数 schema 已加载）：',
    ...(lines.length > 0 ? lines : ['（当前没有可发现的业务工具）']),
    '需要调用尚未加载的工具时，先用 request_tool_schema 的 toolName 传入上述精确名称，读取完整参数 schema；加载成功后该 schema 会在后续轮次继续保留。',
  ].join('\n')
}

const TOOL_MANIFEST_CURSOR_PREFIX = 'tool-manifest-v1'

function manifestCatalogFingerprint(query: string, tools: readonly ToolSummary[]): string {
  return fnv1a32(JSON.stringify({
    query,
    tools: tools.map((tool) => [tool.name, tool.description, tool.triggers ?? [], tool.runtime]),
  }))
}

function manifestCursor(fingerprint: string, offset: number): string {
  return `${TOOL_MANIFEST_CURSOR_PREFIX}:${fingerprint}:${offset}`
}

function parseManifestCursor(cursor: string): { fingerprint: string; offset: number } | undefined {
  const match = /^tool-manifest-v1:([0-9a-f]{8}):([0-9]+)$/.exec(cursor)
  if (!match) return undefined
  const offset = Number(match[2])
  if (!Number.isSafeInteger(offset)) return undefined
  return { fingerprint: match[1], offset }
}

function manifestError(
  code: ToolManifestError['code'],
  error: string,
  query: string,
  limit: number,
): ToolManifestError {
  return {
    kind: 'tool_manifest_error',
    code,
    error,
    restart: { query, limit },
  }
}

/**
 * 返回经过环境/权限过滤的有界工具目录页，不包含 inputSchema 或 guide。
 *
 * query 以空白分词，对 name/description/triggers/runtime 做大小写无关的 AND 匹配；结果固定按名称排序。
 * cursor 同时绑定 query 与完整匹配目录的指纹。翻页期间 registry 变化时返回 stale_cursor，
 * 让调用方从第一页重启，避免 offset 漂移导致工具被静默跳过。
 */
export function searchToolManifestPage(
  input: ToolManifestSearchInput,
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): ToolManifestResult {
  const query = input.query?.trim() ?? ''
  const limit = normalizedManifestLimit(input.limit)
  if (query.length > MAX_TOOL_MANIFEST_QUERY_LENGTH) {
    return manifestError(
      'query_too_long',
      `query 最多 ${MAX_TOOL_MANIFEST_QUERY_LENGTH} 个字符`,
      query.slice(0, MAX_TOOL_MANIFEST_QUERY_LENGTH),
      limit,
    )
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matched = availableToolSummaries(isTauri, options).filter((tool) => {
    if (terms.length === 0) return true
    const searchable = [
      tool.name,
      tool.description,
      ...(tool.triggers ?? []),
      tool.runtime,
    ].join('\n').toLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
  const fingerprint = manifestCatalogFingerprint(query, matched)

  let offset = 0
  if (input.cursor) {
    const parsed = parseManifestCursor(input.cursor)
    if (!parsed) {
      return manifestError('invalid_cursor', 'cursor 格式无效，请从第一页重新查询', query, limit)
    }
    if (parsed.fingerprint !== fingerprint) {
      return manifestError(
        'stale_cursor',
        '工具目录或 query 已变化，请从第一页重新查询',
        query,
        limit,
      )
    }
    if (parsed.offset >= matched.length && parsed.offset !== 0) {
      return manifestError('invalid_cursor', 'cursor 已超出结果范围，请从第一页重新查询', query, limit)
    }
    offset = parsed.offset
  }

  const items = matched.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  const hasMore = nextOffset < matched.length
  return {
    kind: 'tool_manifest_page',
    query,
    items,
    total: matched.length,
    limit,
    hasMore,
    ...(hasMore ? { nextCursor: manifestCursor(fingerprint, nextOffset) } : {}),
  }
}

/**
 * 维护有界的 schema 请求 LRU（新 → 旧）。执行层每处理一次带 toolName 的
 * request_tool_schema 后调用它，再把结果作为 recentToolNames 传给 buildTurnTools。
 */
export function touchRecentToolName(
  current: readonly string[],
  toolName: string,
  maxEntries = maxTurnToolsForVendor('') - 1,
): string[] {
  const capacity = Number.isFinite(maxEntries)
    ? Math.max(0, Math.floor(maxEntries))
    : maxTurnToolsForVendor('') - 1
  if (capacity === 0) return []
  const next = toolName
    ? [toolName, ...current.filter((name) => name !== toolName)]
    : [...current]
  return next.slice(0, capacity)
}

/**
 * 从所有已加载工具中选本轮工作集：显式 LRU 优先，其余按 visible 的后加载优先；
 * 选中后重新按名称排序，兼顾“最近请求可回归”和线上请求字节稳定。
 */
export function selectTurnLoadedTools(
  visible: readonly LoadedTool[],
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): LoadedTool[] {
  const capacity = normalizedMaxTurnTools(options?.maxTools, options?.vendor) - 1
  if (capacity <= 0) return []

  const byName = new Map<string, LoadedTool>()
  for (const tool of visible) {
    if (
      tool.name !== 'request_tool_schema'
      && isToolVisible(tool.runtime, isTauri)
      && isToolAllowed(tool.name, options)
    ) {
      // 同名重复时采用最后一个快照；registry 重注册后的新 schema 通常位于列表尾部。
      byName.set(tool.name, tool)
    }
  }

  const priorityNames: string[] = []
  const seen = new Set<string>()
  const addPriority = (name: string) => {
    if (!seen.has(name) && byName.has(name)) {
      seen.add(name)
      priorityNames.push(name)
    }
  }
  for (const name of options?.recentToolNames ?? []) addPriority(name)
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    addPriority(visible[index].name)
  }

  return priorityNames
    .slice(0, capacity)
    .map((name) => byName.get(name)!)
    .sort((left, right) => compareStableText(left.name, right.name))
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
// 详情：request_tool_schema 恒在场；其后最多 provider descriptor 上限减一的已加载 schema 的 visible tools。
// 超预算时优先最近请求/后加载的工具，再按名称稳定输出。未加载的工具不进；server 工具在 web
// 下（isTauri=false）既不能经 manifest 发现，也不进 visible（TP3，防御 web 混入的 server 工具）。
export function buildTurnTools(
  visible: LoadedTool[],
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): ModelFunctionTool[] {
  return [
    requestSchemaTool(),
    ...selectTurnLoadedTools(visible, isTauri, options)
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
// 不再把全 registry 塞进 toolName.enum：省略 toolName 时由执行层调用 searchToolManifestPage，
// 返回有界、可搜索、可继续翻页的 manifest；给出精确 toolName 时保持原有加载行为。
function requestSchemaTool(): ModelFunctionTool {
  return {
    type: 'function',
    function: {
      name: 'request_tool_schema',
      description: [
        'Lazy-load one exact tool schema so it becomes callable this run.',
        'If the exact name is unknown, omit toolName and use query/cursor/limit to browse a bounded manifest page.',
      ].join(' '),
      parameters: canonicalizeJsonSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          toolName: {
            type: 'string',
            minLength: 1,
            description: 'Exact tool name returned by a manifest page. Omit this field to discover tools.',
          },
          query: {
            type: 'string',
            maxLength: MAX_TOOL_MANIFEST_QUERY_LENGTH,
            description: 'Optional case-insensitive search text used when toolName is omitted.',
          },
          cursor: {
            type: 'string',
            description: 'Opaque nextCursor from the preceding manifest page.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_TOOL_MANIFEST_PAGE_SIZE,
            default: DEFAULT_TOOL_MANIFEST_PAGE_SIZE,
          },
          reason: { type: 'string', minLength: 1 },
        },
        required: ['reason'],
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

// 简介：判定一条 tool 结果是不是「直接调用被当作加载请求」的产物（modelRun 的 lazy 闸门）。
// 详情：只认 code 判别码 + 工具名自洽两条硬判据，避免某个业务工具碰巧回了 {loaded:true} 就被
//   误当成一次 schema 加载。
function autoloadedToolName(
  content: string,
  calledToolName: string | undefined,
): string | undefined {
  if (!calledToolName) return undefined
  const result = parsedObject(content)
  if (!result) return undefined
  return result.code === TOOL_SCHEMA_AUTOLOADED_CODE && result.toolName === calledToolName
    ? calledToolName
    : undefined
}

// 简介：从历史的 schema 加载 call/result 恢复已成功加载的工具名。
// 详情：只读取历史、不改写发给模型的 messages。调用方应从当前 registry 重新取得最新 schema，
// 放入请求顶层 tools；原始 loader call/result 继续进入模型请求，保持缓存前缀与执行因果。
// 两个加载入口都要认账：显式的 request_tool_schema，以及【直接调用未加载工具】被闸门就地转成
// 的那一次加载 —— 后者同样让该工具此后长期可用，漏认会让重启/回滚后的会话白白重新加载一次。
export function loadedToolNamesFromHistory(messages: readonly ModelItem[]): string[] {
  const requestedByCallId = new Map<string, string>()
  const directCallByCallId = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.function.name !== 'request_tool_schema') {
          directCallByCallId.set(toolCall.id, toolCall.function.name)
          continue
        }
        const parsed = parseToolCallArgs(toolCall.function.arguments)
        const toolName = parsed.ok && typeof parsed.args.toolName === 'string'
          ? parsed.args.toolName.trim()
          : undefined
        if (toolName) requestedByCallId.set(toolCall.id, toolName)
      }
    }
  }

  // Set 的 delete + add 会把重复项移到迭代尾部，因此返回顺序是最旧 → 最新，
  // 可直接作为恢复期 LRU。只用首次出现顺序会让后来重新请求过的工具在恢复时被误淘汰。
  const loadedToolNames = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const requestedToolName = requestedByCallId.get(message.tool_call_id)
    const loaded = requestedToolName
      ? loadedToolName(message.content, requestedToolName)
      : autoloadedToolName(message.content, directCallByCallId.get(message.tool_call_id))
    if (!loaded) continue
    loadedToolNames.delete(loaded)
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
