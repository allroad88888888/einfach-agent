// apps/web/src/agentNew/ui/PluginToolToggleList.tsx
// ---------------------------------------------------------------------------
// 插件卡片里的模型可见工具勾选面（P6，拍板 3：默认不进模型清单，逐个勾选才放行）。
// 只负责渲染这一组复选框并把勾选动作转给 plugins/commands.ts，不知道插件行的其余部分。

import { useId } from 'react'
import { Trans } from '@lingui/react/macro'
import { setPluginToolEnabled } from '../../plugins/commands'
import type { PluginRow } from '../../plugins/types'

/** Renders the per-tool model-visibility checkboxes for one plugin row. */
export function PluginToolToggleList({
  row,
  busy,
}: {
  row: PluginRow
  busy: boolean
}) {
  const listId = useId()
  if (row.tools.length === 0) return null

  // 停用/加载失败的插件不该能勾：这时"放行一个工具"没有落点，勾了也只是记在存储里，
  // 界面上却看着像已生效。先把插件本身启用起来再说。
  const locked = busy || row.status !== 'enabled'

  return (
    <div className="agentnew-plugin-tools">
      <p className="agentnew-plugin-tools-hint">
        <Trans>模型可见工具（{row.withheldToolsCount}/{row.tools.length} 未启用）：
        勾选后此工具将进入模型上下文与执行路径，请只勾选你信任的工具。</Trans>
      </p>
      <ul>
        {row.tools.map((tool) => {
          const inputId = `${listId}-${tool.name}`
          return (
            <li key={tool.name}>
              <input
                id={inputId}
                type="checkbox"
                checked={tool.enabled}
                disabled={locked}
                onChange={(event) => {
                  void setPluginToolEnabled(row.dirName, tool.name, event.target.checked)
                }}
              />
              <label htmlFor={inputId}>
                <code>{tool.name}</code>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
