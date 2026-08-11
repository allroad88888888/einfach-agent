// TK3 tool lazy 加载闸门（移植自旧 loop.ts 的 appendVisibleTool / ensureToolLoaded，纯逻辑版）。
// ---------------------------------------------------------------------------
// 设计契约：manifest-only + lazy schema。
//   · model 只看 listToolSummaries()（无 inputSchema）；只有真正被 ensure 的 tool
//     才 loadTool() 合成完整 schema，加入本轮可见工具列表。禁止预加载。
// agentNew 无 timeline：去掉旧版 timeline 写入 / wait 延时，只保留纯逻辑。
//
// 【实例化 · 第 3 期穿线】ensureToolLoaded 补了尾参 core（CoreInstance，默认 defaultCore）：
//   函数体内一律经传入的 core 读写——模块级 toolRegistry → core.tools，未穿 core 的 patchRun(...) →
//   patchRun(..., core)（sessionWriters 的 patchRun 第 2 期已支持 core 尾参）。默认值就是
//   defaultCore（= 穿线前的模块全局单例；tools/registry.ts 导出的 toolRegistry 本身也只是
//   defaultCore.tools 的视图），所以【不传 core 的调用点（modelRun.ts 现有调用 + 全部现有测试）
//   行为逐字不变】。传入独立 core（如 createCoreInstance() 造的实例）时，schema 只从该 core 自己的
//   工具注册表懒加载、累计的 loadedTools 也只回落该 core 自己的 run，与 defaultCore 互不污染
//   （第 3 期隔离证明，见 toolLoading.test.ts）。

import type { LoadedTool } from '../tools/types'
import type { ToolCatalog } from '../tools/toolCatalog'
import { sessionsAtom } from '../state/rootAtoms'
import { patchRun } from '../state/sessionWriters'
import { defaultCore, type CoreInstance } from './core/coreInstance'
import { persistSessions } from './persistenceBridge'
import { selectToolsWithinLimit } from './planToolPins'

// 简介：给“模型调用了本轮未暴露工具”生成可自愈的结构化结果。
// 详情：不泄漏未加载 schema，只明确指出 lazy-tool 协议和下一次应发起的元工具调用。
// 主 Agent 用统一载荷代替含糊的参数缺失或 not allowed，便于模型按 nextCall 自愈。
export function toolSchemaNotLoadedResult(toolName: string): Record<string, unknown> {
  return {
    error: `工具 ${toolName} 的 schema 尚未加载，不能直接调用`,
    code: 'tool_schema_not_loaded',
    hint: '请先调用 request_tool_schema，读取完整参数 schema 后再重新调用该工具',
    nextCall: {
      name: 'request_tool_schema',
      arguments: {
        toolName,
        reason: `调用 ${toolName} 前加载参数 schema`,
      },
    },
  }
}

export function toolRegistrationChangedResult(
  toolName: string,
  expectedRegistrationVersion: number | undefined,
  currentRegistrationVersion: number | undefined,
): Record<string, unknown> {
  return {
    error: `工具 ${toolName} 的注册已变化，已拒绝执行旧调用`,
    code: 'tool_registration_changed',
    expectedRegistrationVersion,
    currentRegistrationVersion,
    hint: '请重新调用 request_tool_schema 读取当前 schema，再重新发起工具调用',
  }
}

// 简介：把工具加入本轮可见工具列表。
// 详情：按 name 去重后返回新数组；已含则原样返回（同引用），只有出现在列表里的 schema 才会暴露给下一轮 model。
export function appendVisibleTool(current: LoadedTool[], next: LoadedTool): LoadedTool[] {
  if (current.some((tool) => tool.name === next.name)) return current
  return [...current, next]
}

function visibleToolLimit(maxVisibleTools: number | undefined): number | undefined {
  if (maxVisibleTools === undefined || !Number.isFinite(maxVisibleTools)) return undefined
  return Math.max(0, Math.floor(maxVisibleTools))
}

function trimVisibleTools(
  tools: LoadedTool[],
  maxVisibleTools: number | undefined,
  pinnedToolNames?: readonly string[],
): LoadedTool[] {
  return selectToolsWithinLimit(tools, visibleToolLimit(maxVisibleTools), pinnedToolNames)
}

function sameRegistration(left: LoadedTool, right: LoadedTool): boolean {
  return left.registrationVersion !== undefined
    && right.registrationVersion !== undefined
    && left.registrationVersion === right.registrationVersion
}

function nextSessionLoadedToolNames(
  id: string,
  toolName: string,
  core: CoreInstance,
  maxVisibleTools: number | undefined,
): string[] | undefined {
  const session = core.rootStore.getter(sessionsAtom)[id]
  if (!session) return undefined

  // SessionMeta 保存的是“期望在下次 run / 应用重启后恢复”的 LRU，而不是 registry
  // 此刻恰好在线的工具集合。动态 MCP 在重连前可能暂时不存在，不能因此把它从缓存抹掉。
  const loadedTools: string[] = []
  for (const name of session.loadedTools ?? []) {
    if (typeof name !== 'string' || name.length === 0 || name === toolName) continue
    const duplicateIndex = loadedTools.indexOf(name)
    if (duplicateIndex >= 0) loadedTools.splice(duplicateIndex, 1)
    loadedTools.push(name)
  }
  loadedTools.push(toolName)

  const limit = visibleToolLimit(maxVisibleTools)
  if (limit === undefined || loadedTools.length <= limit) return loadedTools
  if (limit === 0) return []
  return loadedTools.slice(-limit)
}

function persistVisibleToolNames(
  id: string,
  before: readonly LoadedTool[],
  after: readonly LoadedTool[],
  core: CoreInstance,
  durableLoadedTools?: readonly string[],
): void {
  const visibleChanged = (
    before.length !== after.length
    || before.some((tool, index) => tool.name !== after[index]?.name)
  )
  if (visibleChanged) {
    patchRun(id, { loadedTools: after.map((tool) => tool.name) }, core)
  }
  if (durableLoadedTools === undefined) return

  // RunState 只镜像本次运行内当前可见的 schema；SessionMeta 保存期望恢复的会话级
  // LRU。后者仅在成功加载 / touch 时更新，工具暂时注销或 MCP 尚未重连时不能删除。
  // 独立 CoreInstance 仍只更新自己的 rootStore；现有 persistence driver 只服务 defaultCore。
  const loadedTools = [...durableLoadedTools]
  let sessionChanged = false
  core.rootStore.setter(sessionsAtom, (sessions) => {
    const session = sessions[id]
    if (!session) return sessions
    const persisted = session.loadedTools ?? []
    if (
      persisted.length === loadedTools.length
      && persisted.every((name, index) => name === loadedTools[index])
    ) {
      return sessions
    }
    sessionChanged = true
    return {
      ...sessions,
      [id]: {
        ...session,
        loadedTools,
      },
    }
  })
  if (sessionChanged && core === defaultCore) {
    persistSessions({
      reason: 'tool_schema_visibility_changed',
      sessionId: id,
    })
  }
}

/**
 * Refresh the current visible-tool snapshots from the given tool catalog.
 *
 * Same-name registrations are versioned, so a reconnect/tools_changed event can
 * replace an MCP adapter without leaving its old schema active. Tools the catalog
 * no longer resolves are dropped. Unchanged registrations retain their object
 * identity, keeping the request tool-set stable when a reconnect does not actually
 * change a schema.
 *
 * `catalog` defaults to the live registry. A run passes its own tool epoch instead,
 * so a mid-run unregister cannot shrink the tool-set already shown to the model.
 */
export function refreshVisibleTools(
  id: string,
  currentTools: LoadedTool[],
  core: CoreInstance = defaultCore,
  maxVisibleTools?: number,
  pinnedToolNames?: readonly string[],
  catalog: ToolCatalog = core.tools,
): LoadedTool[] {
  const refreshed: LoadedTool[] = []
  const seen = new Set<string>()
  let changed = false

  // Walk newest-to-oldest so a defensive duplicate keeps the most recent entry.
  for (let index = currentTools.length - 1; index >= 0; index -= 1) {
    const current = currentTools[index]
    if (seen.has(current.name)) {
      changed = true
      continue
    }
    seen.add(current.name)

    const latest = catalog.loadSchema(current.name)
    if (!latest) {
      changed = true
      continue
    }
    if (!sameRegistration(current, latest)) changed = true
    refreshed.push(sameRegistration(current, latest) ? current : latest)
  }
  refreshed.reverse()

  const trimmed = trimVisibleTools(refreshed, maxVisibleTools, pinnedToolNames)
  if (trimmed !== refreshed) changed = true
  const nextTools = changed ? trimmed : currentTools
  persistVisibleToolNames(id, currentTools, nextTools, core)
  return nextTools
}

// 简介：确保某个工具的 schema 已加载到本轮可见列表，并把累计已载写回 run。
// 详情：每次都从工具目录读取当前注册快照；同名重注册会替换旧 schema，并把本次请求的工具移到
// LRU 尾部。unknown 会清掉同名旧快照。maxVisibleTools 用于 provider 的硬 tool 数量预算。
// core 默认 defaultCore，语义见文件头；catalog 默认就是该 core 的活 registry，run 会改传
// 自己的工具集 epoch（见 refreshVisibleTools 的说明）。
export function ensureToolLoaded(
  id: string,
  currentTools: LoadedTool[],
  toolName: string,
  core: CoreInstance = defaultCore,
  maxVisibleTools?: number,
  pinnedToolNames?: readonly string[],
  catalog: ToolCatalog = core.tools,
): LoadedTool[] {
  const tool = catalog.loadSchema(toolName)
  const currentIndex = currentTools.findIndex((loadedTool) => loadedTool.name === toolName)
  if (!tool) {
    if (currentIndex < 0) return currentTools
    const withoutRemoved = currentTools.filter((loadedTool) => loadedTool.name !== toolName)
    const nextTools = trimVisibleTools(withoutRemoved, maxVisibleTools, pinnedToolNames)
    persistVisibleToolNames(id, currentTools, nextTools, core)
    return nextTools
  }

  // Requesting a schema is also an LRU touch. Keeping the most recently requested
  // tools at the tail lets a capped provider rotate an older tool back into view.
  const existing = currentIndex >= 0 ? currentTools[currentIndex] : undefined
  const limit = visibleToolLimit(maxVisibleTools)
  if (
    existing
    && sameRegistration(existing, tool)
    && currentIndex === currentTools.length - 1
    && (limit === undefined || currentTools.length <= limit)
  ) {
    return currentTools
  }
  const promoted = [
    ...currentTools.filter((loadedTool) => loadedTool.name !== toolName),
    existing && sameRegistration(existing, tool) ? existing : tool,
  ]
  const nextTools = trimVisibleTools(promoted, maxVisibleTools, pinnedToolNames)
  persistVisibleToolNames(
    id,
    currentTools,
    nextTools,
    core,
    nextSessionLoadedToolNames(id, toolName, core, maxVisibleTools),
  )
  return nextTools
}
