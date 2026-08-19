// 组本轮暴露给 model 的 function tools 工作集（TK3 + TP3）：选谁进、怎么排、连同恒在场的元工具。

import {
  maxTurnToolsForVendor,
  type ModelFunctionTool,
} from '@einfach-agent/ai'
import type { LoadedTool } from '../tools/types'
import { compareStableText } from './shared/stableTextOrder'
import { canonicalizeJsonSchema } from './toolSchemaCanonical'
import {
  DEFAULT_TOOL_MANIFEST_PAGE_SIZE,
  MAX_TOOL_MANIFEST_PAGE_SIZE,
  MAX_TOOL_MANIFEST_QUERY_LENGTH,
} from './toolManifest'
import {
  isToolAllowed,
  isToolVisible,
  type BuildTurnToolsOptions,
} from './turnToolVisibility'

// 每个 provider 的 function tools 容量由 @einfach-agent/ai 的 canonical vendor descriptor 提供。
// request_tool_schema 固定占一个槽位，maxTools 只能在该 provider 的上限内继续下调。
function normalizedMaxTurnTools(value: number | undefined, vendor: string | undefined): number {
  const maximum = maxTurnToolsForVendor(vendor ?? '')
  if (typeof value !== 'number' || !Number.isFinite(value)) return maximum
  return Math.max(1, Math.min(maximum, Math.floor(value)))
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
  hostHasLocalCapabilities: boolean,
  options?: BuildTurnToolsOptions,
): LoadedTool[] {
  const capacity = normalizedMaxTurnTools(options?.maxTools, options?.vendor) - 1
  if (capacity <= 0) return []

  const byName = new Map<string, LoadedTool>()
  for (const tool of visible) {
    if (
      tool.name !== 'request_tool_schema'
      && isToolVisible(tool.runtime, hostHasLocalCapabilities)
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

// 简介：组本轮暴露给 model 的 function 列表（TK3 + TP3）。
// 详情：request_tool_schema 恒在场；其后最多 provider descriptor 上限减一的已加载 schema 的 visible tools。
// 超预算时优先最近请求/后加载的工具，再按名称稳定输出。未加载的工具不进；宿主给不出本机能力时
// （hostHasLocalCapabilities=false）server 工具既不能经 manifest 发现，也不进 visible
// （TP3，防御无本机能力的宿主混入 server 工具）。参数为什么不再叫 isTauri 见 turnToolVisibility.ts
// 的 isToolVisible —— 这里只是同一个总闸的另一条流：清单文本走 toolManifest，实际传给模型的
// tools 数组走这里，两条必须同判据。
export function buildTurnTools(
  visible: LoadedTool[],
  hostHasLocalCapabilities: boolean,
  options?: BuildTurnToolsOptions,
): ModelFunctionTool[] {
  return [
    requestSchemaTool(),
    ...selectTurnLoadedTools(visible, hostHasLocalCapabilities, options)
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
