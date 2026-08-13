// apps/web/src/plugins/rows.ts —— LoadedPlugin + 用户记录 → PluginRow 的投影
// ---------------------------------------------------------------------------
// 只做一件事：把 P4 的加载结果与按用户存的启停/勾选记录合成面板要渲染的那份纯数据。
// 全是纯函数，不碰 store、不碰 provider——编排在 service.ts。

import type {
  LoadedPlugin,
  PluginRow,
  PluginRowStatus,
  PluginToggleRecord,
  PluginToggleState,
  PluginToolRow,
  PluginToolToggleRecord,
} from './types'

/** 单个工具当前是否被用户勾中；记录缺失即"没勾"，与 P4 闸门的默认关同构。 */
export function isToolChecked(
  tools: PluginToolToggleRecord,
  pluginId: string,
  toolName: string,
): boolean {
  return tools[pluginId]?.[toolName] === true
}

function deriveStatus(item: LoadedPlugin, disabled: PluginToggleRecord): PluginRowStatus {
  if (item.status === 'incompatible') return 'incompatible'
  if (item.status === 'failed') return item.id === undefined ? 'invalid' : 'failed'
  // item.status === 'enabled'：manifest 解析成功过，identity 必然存在（见 pluginLoader.ts）。
  if (item.id !== undefined && disabled[item.id]) return 'disabled'
  return 'enabled'
}

/**
 * 该插件的工具勾选面。
 *
 * 名单 = 本次加载被闸门拦下的工具 ∪ 用户勾过且已放行的工具。后半截不能省：勾中之后
 * 工具会从 withheldTools 挪进 grantedTools，只看 withheldTools 的话勾一下就再也找不到它、
 * 也就没法取消。反过来也不能把 grantedTools 整个收进来——里面还有 `callTiming` 非空、
 * 本就不受闸门管的到点工具，给它们渲染勾选框是在假装用户能控制一件他控制不了的事。
 *
 * 按名字排序而不是按来源拼接：勾选会让一个工具在两个数组之间跳，排序保证列表在勾/取消
 * 之间位置稳定，不会让用户点完一个复选框后下一个选项跑到别处。
 */
export function toToolRows(item: LoadedPlugin, tools: PluginToolToggleRecord): readonly PluginToolRow[] {
  const pluginId = item.id
  if (pluginId === undefined) return []
  const names = new Set(item.withheldTools)
  for (const name of item.grantedTools) {
    if (isToolChecked(tools, pluginId, name)) names.add(name)
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, enabled: isToolChecked(tools, pluginId, name) }))
}

export function toRow(item: LoadedPlugin, state: PluginToggleState): PluginRow {
  const status = deriveStatus(item, state.disabled)
  const tools = toToolRows(item, state.tools)
  return {
    dirName: item.dirName,
    ...(item.id !== undefined ? { id: item.id } : {}),
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.version !== undefined ? { version: item.version } : {}),
    status,
    diagnostics: item.diagnostics,
    withheldToolsCount: tools.filter((tool) => !tool.enabled).length,
    tools,
    // 是否可以在这一行上点启停开关。只有真正装过（曾经是 P4 的 enabled，无论用户
    // 是否已停用）才可切换；failed/incompatible/invalid 要先解决插件自身的问题。
    toggleable: status === 'enabled' || status === 'disabled',
  }
}

/** 在勾选记录上落一次改动，返回新的整份 state（记录只存 true，取消即删键）。 */
export function withToolToggle(
  state: PluginToggleState,
  pluginId: string,
  toolName: string,
  enabled: boolean,
): PluginToggleState {
  const current: Record<string, boolean> = { ...(state.tools[pluginId] ?? {}) }
  if (enabled) current[toolName] = true
  else delete current[toolName]
  const tools: Record<string, Readonly<Record<string, boolean>>> = { ...state.tools }
  if (Object.keys(current).length > 0) tools[pluginId] = current
  else delete tools[pluginId]
  return { disabled: state.disabled, tools }
}

/** 在启停记录上落一次改动，返回新的整份 state。 */
export function withPluginDisabled(
  state: PluginToggleState,
  pluginId: string,
  disabled: boolean,
): PluginToggleState {
  const next: Record<string, boolean> = { ...state.disabled }
  if (disabled) next[pluginId] = true
  else delete next[pluginId]
  return { disabled: next, tools: state.tools }
}
