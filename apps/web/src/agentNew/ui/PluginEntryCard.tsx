// apps/web/src/agentNew/ui/PluginEntryCard.tsx
// ---------------------------------------------------------------------------
// 渲染插件设置面板里的一行：身份 + 状态徽标、诊断折叠、withheldTools 计数提示、
// 可切换时的启停按钮。样式对齐 McpServerCard.tsx 的既有 card 结构。

import { disablePlugin, enablePlugin } from '../../plugins/commands'
import type { PluginOperation } from '../../plugins/state'
import type { PluginRow, PluginRowStatus } from '../../plugins/types'

const STATUS_LABELS: Record<PluginRowStatus, string> = {
  enabled: '已启用',
  disabled: '已停用',
  failed: '加载失败',
  incompatible: '版本不兼容',
  invalid: '清单无效',
}

function displayName(row: PluginRow): string {
  return row.name ?? row.dirName
}

function toggleLabel(row: PluginRow, operation?: PluginOperation): string {
  if (operation === 'disabling') return '停用中'
  if (operation === 'enabling') return '启用中'
  return row.status === 'enabled' ? '停用' : '启用'
}

/** Renders one loaded/failed plugin entry and its enable/disable control. */
export function PluginEntryCard({
  row,
  operation,
}: {
  row: PluginRow
  operation?: PluginOperation
}) {
  const busy = operation !== undefined
  const name = displayName(row)

  return (
    <article className="agentnew-plugin-card" aria-label={`插件 ${name}`}>
      <div className="agentnew-plugin-card-head">
        <div>
          <div className="agentnew-plugin-card-title">
            <strong>{name}</strong>
            <span className={`agentnew-plugin-status is-${row.status}`}>
              <i aria-hidden="true" />
              {STATUS_LABELS[row.status]}
            </span>
          </div>
          <span className="agentnew-plugin-meta">
            {row.id ? <code>{row.id}</code> : row.dirName}
            {row.version ? ` · v${row.version}` : ''}
          </span>
        </div>
        {row.toggleable ? (
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy}
            onClick={() => {
              void (row.status === 'enabled' ? disablePlugin(row.dirName) : enablePlugin(row.dirName))
            }}
          >
            {toggleLabel(row, operation)}
          </button>
        ) : null}
      </div>

      {row.withheldToolsCount > 0 ? (
        <p className="agentnew-plugin-withheld">
          {row.withheldToolsCount} 个模型可见工具待勾选
        </p>
      ) : null}

      {row.diagnostics.length > 0 ? (
        <details className="agentnew-plugin-diagnostics">
          <summary>诊断（{row.diagnostics.length} 条）</summary>
          <ul>
            {row.diagnostics.map((diagnostic, index) => (
              <li key={index}>{diagnostic}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  )
}
