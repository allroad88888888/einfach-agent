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
  // connect/reconnect 正在跑：这是真的在发生的事，说"连接中/重连中"没问题。
  if (operation === 'connect') return '连接中'
  if (operation === 'reconnect') return '重连中'
  const labels = {
    disconnected: '未连接',
    connecting: '连接中',
    // 走到这里说明没有进行中的 connect/reconnect 操作：上一次尝试已经落定
    // 在"暂时性失败"分类（见 tools/mcp/src/failureClassification.ts），
    // 但当前没有任何重试在后台跑——自动退避重连是 D2 的范围，还没做。
    // 用"不稳定"而不是"重连中"，避免让用户以为系统正在自动处理。
    reconnecting: '连接不稳定',
    connected: '已连接',
    error: '需要处理',
  }
  return labels[server.status]
}

interface McpStatusNote {
  /** 'retry'：暂时性问题，不需要用户改配置。'permanent'：需要人工介入。 */
  tone: 'retry' | 'permanent'
  heading: string
  advice: string
}

/**
 * server.error 只会在"当前没有进行中的 connect/reconnect 尝试"时出现——
 * clientManager 开始一次新尝试时会先清空 error（connectInternal），只有
 * 尝试落定失败后才会重新写入。所以这里不必再看 operation：error 存在
 * 本身就意味着"停在失败态"，而不是"正在尝试"。这就是手动重连触发的
 * 'reconnecting' 和失败后停留的 'reconnecting' 不需要在这里分开处理的原因：
 * 前者没有 error，走上面的 statusLabel busy 分支；后者才会走到这个函数。
 */
function statusNote(server: McpServerView): McpStatusNote | undefined {
  if (!server.error) return undefined
  if (server.status === 'error') {
    return {
      tone: 'permanent',
      heading: '需要你处理',
      advice: '请检查服务地址、启动命令、参数或访问凭据是否正确，修正后点击下方"重连"。',
    }
  }
  if (server.status === 'reconnecting') {
    return {
      tone: 'retry',
      // 不写「不是配置问题」：认证失败现在也落在 reconnecting（凭证错与服务临时故障
      // 在没有 401/403 时无法区分），断言它与配置无关会与下面的分类文案自相矛盾。
      heading: '暂时中断，正在自动重连',
      // D2 落地后这里确实有后台退避在跑（1s 起指数退避、封顶 30s、最多 6 次），
      // 所以可以如实说；耗尽后状态会转成 'error'，走下面那一档。
      advice: '正在按退避间隔自动重连，最多 6 次；不想等可以点击下方"重连"立即重试。',
    }
  }
  return undefined
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
  const note = statusNote(server)
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
      {note ? (
        <div
          className={`agentnew-mcp-status-note is-${note.tone}`}
          role={note.tone === 'permanent' ? 'alert' : 'status'}
        >
          <strong>{note.heading}</strong>
          <p>{server.error}</p>
          <p>{note.advice}</p>
        </div>
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
