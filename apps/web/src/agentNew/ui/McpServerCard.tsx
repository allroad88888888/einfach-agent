import type { McpLaunchConsentRequest } from '../../mcp/launchConsentState'
import type { McpServerOperation, McpServerView } from '../../mcp/types'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  disconnectMcpServer,
  reconnectMcpServer,
  removeMcpServer,
  setMcpServerAutoConnect,
} from '../../mcp/commands'
import { McpLaunchConsentPrompt } from './McpLaunchConsentPrompt'
import { McpServerToolSummary } from './McpServerToolSummary'

type McpStatusNoteTone = 'retry' | 'permanent'

/**
 * server.error 只会在"当前没有进行中的 connect/reconnect 尝试"时出现——
 * clientManager 开始一次新尝试时会先清空 error（connectInternal），只有
 * 尝试落定失败后才会重新写入。所以这里不必再看 operation：error 存在
 * 本身就意味着"停在失败态"，而不是"正在尝试"。这就是手动重连触发的
 * 'reconnecting' 和失败后停留的 'reconnecting' 不需要在这里分开处理的原因：
 * 前者没有 error，走上面的 statusLabel busy 分支；后者才会走到这个函数。
 */
function statusNoteTone(server: McpServerView): McpStatusNoteTone | undefined {
  if (!server.error) return undefined
  if (server.status === 'error') return 'permanent'
  if (server.status === 'reconnecting') {
    // 不写「不是配置问题」：认证失败现在也落在 reconnecting（凭证错与服务临时故障
    // 在没有 401/403 时无法区分），断言它与配置无关会与下面的分类文案自相矛盾。
    return 'retry'
  }
  return undefined
}

/** Renders one persisted MCP server and its connection controls. */
export function McpServerCard({
  server,
  operation,
  stdioAvailable,
  temporaryStorage,
  launchRequest,
  launchConfirmed = true,
}: {
  server: McpServerView
  operation?: McpServerOperation
  stdioAvailable: boolean
  temporaryStorage: boolean
  /** 待用户确认的启动命令；有值时卡片上会摆出完整命令行（H2）。 */
  launchRequest?: McpLaunchConsentRequest
  /** stdio 的当前命令行是否已被确认过；HTTP 恒为 true。 */
  launchConfirmed?: boolean
}) {
  const { t } = useLingui()
  const busy = operation !== undefined
  const transportUnavailable = server.transport === 'stdio' && !stdioAvailable
  const noteTone = statusNoteTone(server)
  const label = operation === 'disconnect' ? t`注销中`
    : operation === 'remove' ? t`删除中`
      : operation === 'connect' ? t`连接中`
        : operation === 'reconnect' ? t`重连中`
          : {
              disconnected: t`未连接`,
              connecting: t`连接中`,
              reconnecting: t`连接不稳定`,
              connected: t`已连接`,
              error: t`需要处理`,
            }[server.status]
  const note = noteTone ? {
    tone: noteTone,
    heading: noteTone === 'permanent' ? t`需要你处理` : t`暂时中断，正在自动重连`,
    advice: noteTone === 'permanent'
      ? t`请检查服务地址、启动命令、参数或访问凭据是否正确，修正后点击下方"重连"。`
      : t`正在按退避间隔自动重连，最多 6 次；不想等可以点击下方"重连"立即重试。`,
  } : undefined
  const autoConnectHint = server.transport === 'stdio'
    ? temporaryStorage
      ? t`开启后每次启动都会执行该命令；首次需确认命令行，偏好仅在本次会话有效`
      : t`开启后每次启动应用都会自动执行该命令；首次需确认命令行`
    : temporaryStorage
      ? t`切换会立即连接或注销；偏好仅在本次会话有效`
      : t`切换会立即连接或注销，并保存为启动偏好`
  // 只在「停着、而且没有正在等确认的命令行」时解释为什么它没连上：已经摆出确认时不必
  // 重复一遍；正在跑时更不能说「尚未确认」——模型那条路径（F3 的工具确认）也能把 stdio
  // 连起来，那时进程确实在跑，只是设置里还没记下这条命令行的确认。
  const unconfirmedLaunch = !launchConfirmed
    && !transportUnavailable
    && !launchRequest
    && server.status === 'disconnected'
  return (
    <article className="agentnew-mcp-card" aria-label={t`MCP 服务 ${server.name}`}>
      <div className="agentnew-mcp-card-head">
        <div>
          <div className="agentnew-mcp-card-title">
            <strong>{server.name}</strong>
            <span className={`agentnew-mcp-status is-${server.status}`}>
              <i aria-hidden="true" />
              {label}
            </span>
          </div>
          <span className="agentnew-mcp-transport">
            {server.transport === 'streamable-http'
              ? 'Streamable HTTP'
              : transportUnavailable ? t`stdio · 仅桌面端` : 'stdio'}
          </span>
        </div>
        {transportUnavailable ? (
          <div className="agentnew-mcp-manual-connect">
            <strong><Trans>仅桌面端</Trans></strong>
            <small><Trans>当前浏览器不可用；本地进程仅能在桌面端启动</Trans></small>
          </div>
        ) : (
          <label className="agentnew-mcp-auto-connect">
            <span>
              <strong><Trans>自动连接</Trans></strong>
              <small>{autoConnectHint}</small>
            </span>
            <input
              className="agentnew-settings-checkbox"
              type="checkbox"
              checked={server.autoConnect}
              disabled={busy}
              aria-label={t`${server.name} 自动连接`}
              onChange={(event) => {
                void setMcpServerAutoConnect(server.id, event.target.checked)
              }}
            />
          </label>
        )}
      </div>

      <div className="agentnew-mcp-target">
        <span>{server.transport === 'streamable-http' ? t`地址` : t`命令`}</span>
        <code>{server.target}</code>
      </div>
      {server.args.length > 0 ? (
        <div className="agentnew-mcp-detail">
          <Trans>参数：{server.args.join(' · ')}</Trans>
        </div>
      ) : null}
      {server.cwd ? <div className="agentnew-mcp-detail"><Trans>工作目录：{server.cwd}</Trans></div> : null}
      {launchRequest ? <McpLaunchConsentPrompt request={launchRequest} /> : null}
      {unconfirmedLaunch ? (
        <div className="agentnew-mcp-status-note is-retry" role="status">
          <strong><Trans>启动命令尚未确认</Trans></strong>
          <p><Trans>这个服务会在本机启动进程，第一次执行前需要你确认命令行。</Trans></p>
          <p><Trans>点击下方「重连」查看将执行的命令并确认。</Trans></p>
        </div>
      ) : null}
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
        <McpServerToolSummary server={server} />
        <div className="agentnew-mcp-actions">
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy || server.status === 'disconnected'}
            onClick={() => void disconnectMcpServer(server.id)}
          >
            {operation === 'disconnect' ? t`注销中` : t`注销`}
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy || transportUnavailable}
            title={transportUnavailable ? t`stdio MCP 仅可在桌面端连接` : undefined}
            onClick={() => void reconnectMcpServer(server.id)}
          >
            {operation === 'connect' || operation === 'reconnect' ? t`重连中` : t`重连`}
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-small is-danger"
            disabled={busy}
            onClick={() => void removeMcpServer(server.id)}
          >
            {operation === 'remove' ? t`删除中` : t`删除`}
          </button>
        </div>
      </div>
    </article>
  )
}
