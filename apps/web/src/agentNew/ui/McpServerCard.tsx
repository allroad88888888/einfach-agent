import type { McpServerOperation, McpServerView } from '../../mcp/types'
import {
  disconnectMcpServer,
  reconnectMcpServer,
  removeMcpServer,
  setMcpServerAutoConnect,
} from '../../mcp/commands'

function statusLabel(server: McpServerView, operation?: McpServerOperation): string {
  if (operation === 'disconnect') return '注销中'
  if (operation === 'remove') return '删除中'
  const labels = {
    disconnected: '未连接',
    connecting: '连接中',
    reconnecting: '重连中',
    connected: '已连接',
    error: '连接错误',
  }
  return labels[server.status]
}

/** Renders one persisted MCP server and its connection controls. */
export function McpServerCard({
  server,
  operation,
  stdioAvailable,
  temporaryStorage,
}: {
  server: McpServerView
  operation?: McpServerOperation
  stdioAvailable: boolean
  temporaryStorage: boolean
}) {
  const busy = operation !== undefined
  const transportUnavailable = server.transport === 'stdio' && !stdioAvailable
  return (
    <article className="agentnew-mcp-card" aria-label={`MCP 服务 ${server.name}`}>
      <div className="agentnew-mcp-card-head">
        <div>
          <div className="agentnew-mcp-card-title">
            <strong>{server.name}</strong>
            <span className={`agentnew-mcp-status is-${server.status}`}>
              <i aria-hidden="true" />
              {statusLabel(server, operation)}
            </span>
          </div>
          <span className="agentnew-mcp-transport">
            {server.transport === 'streamable-http'
              ? 'Streamable HTTP'
              : `stdio${transportUnavailable ? ' · 仅桌面端' : ''}`}
          </span>
        </div>
        {server.transport === 'stdio' ? (
          <div className="agentnew-mcp-manual-connect">
            <strong>手动连接</strong>
            <small>
              {transportUnavailable
                ? '当前浏览器不可用；本地进程仅能在桌面端启动'
                : '本地进程需每次手动重连'}
            </small>
          </div>
        ) : (
          <label className="agentnew-mcp-auto-connect">
            <span>
              <strong>自动连接</strong>
              <small>
                {temporaryStorage
                  ? '切换会立即连接或注销；偏好仅在本次会话有效'
                  : '切换会立即连接或注销，并保存为启动偏好'}
              </small>
            </span>
            <input
              className="agentnew-settings-checkbox"
              type="checkbox"
              checked={server.autoConnect}
              disabled={busy}
              aria-label={`${server.name} 自动连接`}
              onChange={(event) => {
                void setMcpServerAutoConnect(server.id, event.target.checked)
              }}
            />
          </label>
        )}
      </div>

      <div className="agentnew-mcp-target">
        <span>{server.transport === 'streamable-http' ? '地址' : '命令'}</span>
        <code>{server.target}</code>
      </div>
      {server.args.length > 0 ? (
        <div className="agentnew-mcp-detail">
          参数：{server.args.join(' · ')}
        </div>
      ) : null}
      {server.cwd ? <div className="agentnew-mcp-detail">工作目录：{server.cwd}</div> : null}
      {server.error ? (
        <p className="agentnew-mcp-error" role="alert">{server.error}</p>
      ) : null}

      <div className="agentnew-mcp-card-footer">
        <span>{server.toolCount} 个工具</span>
        <div className="agentnew-mcp-actions">
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy || server.status === 'disconnected'}
            onClick={() => void disconnectMcpServer(server.id)}
          >
            {operation === 'disconnect' ? '注销中' : '注销'}
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy || transportUnavailable}
            title={transportUnavailable ? 'stdio MCP 仅可在桌面端连接' : undefined}
            onClick={() => void reconnectMcpServer(server.id)}
          >
            {operation === 'connect' || operation === 'reconnect' ? '重连中' : '重连'}
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-small is-danger"
            disabled={busy}
            onClick={() => void removeMcpServer(server.id)}
          >
            {operation === 'remove' ? '删除中' : '删除'}
          </button>
        </div>
      </div>
    </article>
  )
}
