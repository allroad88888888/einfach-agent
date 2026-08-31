// apps/web/src/agentNew/ui/PluginEntryCard.tsx
// ---------------------------------------------------------------------------
// 渲染插件设置面板里的一行：身份 + 状态徽标、诊断折叠、模型可见工具勾选面、
// 可切换时的启停按钮。样式对齐 McpServerCard.tsx 的既有 card 结构。

import { useLingui } from '@lingui/react/macro'
import { disablePlugin, enablePlugin } from '../../plugins/commands'
import type { PluginOperation } from '../../plugins/state'
import type { PluginRow } from '../../plugins/types'
import { PluginToolToggleList } from './PluginToolToggleList'

function displayName(row: PluginRow): string {
  return row.name ?? row.dirName
}

/** Renders one loaded/failed plugin entry and its enable/disable control. */
export function PluginEntryCard({
  row,
  operation,
}: {
  row: PluginRow
  operation?: PluginOperation
}) {
  const { t } = useLingui()
  const busy = operation !== undefined
  const name = displayName(row)
  const statusLabels = {
    enabled: t`已启用`,
    disabled: t`已停用`,
    failed: t`加载失败`,
    incompatible: t`版本不兼容`,
    invalid: t`清单无效`,
  }
  const actionLabel = operation === 'disabling'
    ? t`停用中`
    : operation === 'enabling'
      ? t`启用中`
      : row.status === 'enabled' ? t`停用` : t`启用`

  return (
    <article className="agentnew-plugin-card" aria-label={t`插件 ${name}`}>
      <div className="agentnew-plugin-card-head">
        <div>
          <div className="agentnew-plugin-card-title">
            <strong>{name}</strong>
            <span className={`agentnew-plugin-status is-${row.status}`}>
              <i aria-hidden="true" />
              {statusLabels[row.status]}
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
            {actionLabel}
          </button>
        ) : null}
      </div>

      <PluginToolToggleList row={row} busy={busy} />

      {row.diagnostics.length > 0 ? (
        <details className="agentnew-plugin-diagnostics">
          <summary>{t`诊断（${row.diagnostics.length} 条）`}</summary>
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
