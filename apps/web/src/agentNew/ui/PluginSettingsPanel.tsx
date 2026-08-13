// apps/web/src/agentNew/ui/PluginSettingsPanel.tsx
// ---------------------------------------------------------------------------
// 插件设置面板：列出 apps/web/src/plugins/ 的 view-state 产出的 PluginRow。
// 数据来自注入的 PluginSettingsProvider（见 plugins/commands.ts 的 configurePluginSettings），
// 桌面真实接线是 P10 的卡；本面板对"未装配/不支持插件的宿主"一视同仁地显示不支持空态
// （蓝图 3.4：浏览器预览没有 workspace 文件系统，不该装作能扫描插件）。

import { useEffect } from 'react'
import { useAtomValue } from '@einfach/react'
import { hydratePluginSettings } from '../../plugins/commands'
import {
  pluginHydrationAtom,
  pluginOperationsAtom,
  pluginRowsAtom,
  pluginSettingsCapabilitiesAtom,
} from '../../plugins/state'
import { PluginEntryCard } from './PluginEntryCard'
import './PluginSettingsPanel.css'

/** Composes the plugin list panel: unsupported-host, loading/error, empty, and populated states. */
export function PluginSettingsPanel() {
  const capabilities = useAtomValue(pluginSettingsCapabilitiesAtom)
  const hydration = useAtomValue(pluginHydrationAtom)
  const rows = useAtomValue(pluginRowsAtom)
  const operations = useAtomValue(pluginOperationsAtom)

  useEffect(() => {
    void hydratePluginSettings()
  }, [])

  return (
    <section className="agentnew-settings-panel" aria-labelledby="agentnew-plugin-settings-title">
      <div className="agentnew-settings-panel-head">
        <div>
          <h3 id="agentnew-plugin-settings-title">插件</h3>
          <p>管理从 <code>.webAgent/plugins/</code> 加载的第三方插件。</p>
        </div>
      </div>

      {!capabilities.supported ? (
        <div className="agentnew-plugin-empty">
          <span aria-hidden="true">⧉</span>
          <strong>当前宿主不支持用户插件</strong>
          <p>
            用户插件目前仅在桌面端与 CLI 提供；浏览器预览没有 workspace 文件系统访问权限，
            无法扫描 <code>.webAgent/plugins/</code>。
          </p>
        </div>
      ) : hydration.status === 'loading' ? (
        <p className="agentnew-plugin-notice" role="status">正在扫描插件…</p>
      ) : hydration.status === 'error' ? (
        <p className="agentnew-plugin-error" role="alert">{hydration.error}</p>
      ) : rows.length > 0 ? (
        <div className="agentnew-plugin-list">
          {rows.map((row) => (
            <PluginEntryCard key={row.dirName} row={row} operation={operations[row.dirName]} />
          ))}
        </div>
      ) : (
        <div className="agentnew-plugin-empty">
          <span aria-hidden="true">⧉</span>
          <strong>还没有插件</strong>
          <p>
            把插件目录放进 <code>.webAgent/plugins/</code> 后刷新设置即可看到。
          </p>
        </div>
      )}
    </section>
  )
}
