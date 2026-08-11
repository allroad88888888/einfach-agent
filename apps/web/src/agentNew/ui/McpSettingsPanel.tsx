import { useAtomValue } from '@einfach/react'
import { closeMcpAddForm, openMcpAddForm } from '../../mcp/commands'
import {
  mcpPendingLaunchConsentsAtom,
  mcpUnconfirmedLaunchIdsAtom,
} from '../../mcp/launchConsentState'
import {
  mcpAddFormOpenAtom,
  mcpHydrationAtom,
  mcpImportStatusAtom,
  mcpPersistenceModeAtom,
  mcpServerOperationsAtom,
  mcpServersAtom,
  mcpSettingsCapabilitiesAtom,
} from '../../mcp/state'
import { McpAddServerForm } from './McpAddServerForm'
import { McpServerCard } from './McpServerCard'

/** Composes the MCP server list and its add-server workflow. */
export function McpSettingsPanel() {
  const servers = useAtomValue(mcpServersAtom)
  const capabilities = useAtomValue(mcpSettingsCapabilitiesAtom)
  const operations = useAtomValue(mcpServerOperationsAtom)
  const hydration = useAtomValue(mcpHydrationAtom)
  const importStatus = useAtomValue(mcpImportStatusAtom)
  const persistenceMode = useAtomValue(mcpPersistenceModeAtom)
  const addFormOpen = useAtomValue(mcpAddFormOpenAtom)
  // 起进程确认（H2）：待确认的命令行，以及「命令行还没被确认过」的服务。两者都按
  // serverId 分发到对应卡片上——一次导入可能带进来多个 stdio 服务。
  const pendingLaunchConsents = useAtomValue(mcpPendingLaunchConsentsAtom)
  const unconfirmedLaunchIds = useAtomValue(mcpUnconfirmedLaunchIdsAtom)
  const temporaryStorage = persistenceMode === 'temporary'

  return (
    <section className="agentnew-settings-panel" aria-labelledby="agentnew-mcp-settings-title">
      <div className="agentnew-settings-panel-head">
        <div>
          <h3 id="agentnew-mcp-settings-title">MCP 服务</h3>
          <p>连接外部工具服务，并把远端工具安全地提供给当前 Agent。</p>
        </div>
        <button
          type="button"
          className="agentnew-settings-button is-primary"
          onClick={() => addFormOpen ? closeMcpAddForm() : openMcpAddForm()}
        >
          {addFormOpen ? '收起表单' : '+ 添加服务'}
        </button>
      </div>

      {temporaryStorage ? (
        <div
          className="agentnew-mcp-storage-warning"
          role="status"
          aria-label="MCP 存储状态"
        >
          <strong>临时存储模式</strong>
          <span>
            浏览器持久化存储不可用。MCP 配置仅保存在当前会话，刷新或关闭页面后会丢失。
          </span>
        </div>
      ) : null}

      {addFormOpen ? <McpAddServerForm temporaryStorage={temporaryStorage} /> : null}
      {importStatus ? (
        <p className="agentnew-mcp-import-status" role="status">{importStatus}</p>
      ) : null}
      {hydration.status === 'loading' ? (
        <p className="agentnew-mcp-notice" role="status">正在恢复 MCP 服务…</p>
      ) : null}
      {hydration.status === 'error' ? (
        <p className="agentnew-mcp-error" role="alert">{hydration.error}</p>
      ) : null}

      {servers.length > 0 ? (
        <div className="agentnew-mcp-list">
          {servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              operation={operations[server.id]}
              stdioAvailable={capabilities.stdio}
              temporaryStorage={temporaryStorage}
              launchRequest={pendingLaunchConsents[server.id]}
              launchConfirmed={!unconfirmedLaunchIds.has(server.id)}
            />
          ))}
        </div>
      ) : hydration.status !== 'loading' ? (
        <div className="agentnew-mcp-empty">
          <span aria-hidden="true">⌁</span>
          <strong>还没有 MCP 服务</strong>
          <p>
            添加 Streamable HTTP 服务开始使用外部工具
            {capabilities.stdio ? '，桌面端也可使用 stdio。' : '；stdio 仅在桌面端可用。'}
          </p>
        </div>
      ) : null}
    </section>
  )
}
