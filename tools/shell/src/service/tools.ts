import type { Tool } from '@einfach-agent/core/tools'
import { detectShellFileWrite, shellFileWriteRejected } from '../file-write-guard'

const guide = `服务由当前会话的 Node 宿主持有。start_service 只确认进程已启动，不保证端口就绪。使用 get_service_status 和 read_service_logs 检查 readiness；日志 cursor 从 0 开始，后续使用 nextCursor，truncated 表示旧输出已被回收。日志合并 stdout/stderr，最多保留 65536 字符。stop_service 主动停止整个进程组。删除会话向宿主发送结束请求后停止服务；切换会话、结束模型轮次、取消轮次、关闭浏览器不等于删除会话。断网时删除请求无法送达，服务会继续到主动停止或宿主关闭。正常宿主关闭会停止服务；宿主 SIGKILL、断电和自行 setsid/daemonize 的进程无法保证清理。不得使用脱离宿主的启动方式。不支持 Windows 常驻服务。`
const id = { type: 'string', minLength: 1, maxLength: 256 }
function tool(name: string, action: 'start' | 'status' | 'logs' | 'stop', description: string, properties: Record<string, unknown>, required: string[]): Tool {
  return {
    name, runtime: 'server', replayUnsafe: action === 'start' || action === 'stop',
    skill: { description, triggers: ['service', 'server', '常驻服务'], content: guide },
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    async execute(args, ctx) {
      if (!ctx.sessionService) return { ok: false, error: 'Session services unavailable' }
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
      if (action === 'start') {
        if (typeof input.command !== 'string' || !input.command.trim()) return { ok: false, error: 'command is required' }
        const detection = detectShellFileWrite(input.command)
        if (detection) return shellFileWriteRejected(name, detection)
      }
      try { return { ok: true, data: await ctx.sessionService(action, input) } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : typeof error === 'string' && error ? error : 'Service operation failed' } }
    },
  }
}
export const serviceTools = [
  tool('start_service', 'start', '启动当前会话持有的常驻服务。', {
    command: { type: 'string', minLength: 1, maxLength: 32768 }, cwd: { type: 'string', maxLength: 8192 },
    env: { type: 'object', additionalProperties: { type: 'string' } },
  }, ['command']),
  tool('get_service_status', 'status', '查询当前会话服务的运行状态与退出结果。', { serviceId: id }, ['serviceId']),
  tool('read_service_logs', 'logs', '按 cursor 增量读取当前会话服务日志。', {
    serviceId: id, cursor: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 2, maximum: 65536 },
  }, ['serviceId']),
  tool('stop_service', 'stop', '停止当前会话的服务进程组。', { serviceId: id }, ['serviceId']),
]
