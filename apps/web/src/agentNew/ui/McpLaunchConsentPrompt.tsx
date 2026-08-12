import type { McpLaunchConsentRequest } from '../../mcp/launchConsentState'
import { approveMcpServerLaunch, dismissMcpServerLaunch } from '../../mcp/commands'

/**
 * 起进程前的确认（H2）：在真的执行之前，把【完整命令行】原样摆出来。
 *
 * 这条路径是「用户在设置里添加 / 导入 / 重连 / 打开自动连接」，不经过模型，所以它不是
 * 工具确认卡片（那是 F3 给 `connect_mcp_server` 装的门），而是设置界面里的一次明确交互。
 * 提示长在对应服务的卡片里而不是顶部：一次导入可能带进来好几个 stdio 服务，「哪条命令
 * 属于哪个服务」必须是看得见的，不能靠顺序猜。
 */
export function McpLaunchConsentPrompt({ request }: { request: McpLaunchConsentRequest }) {
  return (
    <div
      className="agentnew-mcp-launch-consent"
      role="alert"
      aria-label={`确认启动 ${request.name}`}
    >
      <strong>需要确认：将在本机执行命令</strong>
      <p>确认后会在你的电脑上执行：</p>
      <code>{request.commandLine}</code>
      {request.cwd ? <p>工作目录：{request.cwd}</p> : null}
      {/*
        环境变量只点名，不显示值：值是凭据，而这张卡片会被截屏。要判断的是「这条命令会不会
        被塞进额外的东西」，看见 LD_PRELOAD / NODE_OPTIONS 这样的键名就够了。
      */}
      {request.envNames?.length
        ? <p>环境变量：{request.envNames.join('、')}（值已隐藏）</p>
        : null}
      <p>
        {request.autoConnect
          ? '这条命令现在会执行一次；之后每次启动应用都会自动执行，不再询问。'
          : '这条命令现在会执行一次；之后开启「自动连接」时也不会再询问。'}
      </p>
      <p>请先核对命令、参数、工作目录与环境变量；其中任何一项被改动后都需要重新确认。</p>
      <div className="agentnew-mcp-actions">
        <button
          type="button"
          className="agentnew-settings-button is-small is-primary"
          onClick={() => void approveMcpServerLaunch(request.id)}
        >
          确认并执行
        </button>
        <button
          type="button"
          className="agentnew-settings-button is-small"
          onClick={() => dismissMcpServerLaunch(request.id)}
        >
          暂不执行
        </button>
      </div>
    </div>
  )
}
