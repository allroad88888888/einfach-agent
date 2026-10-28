import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostRouteTable } from '../routeTable'
import { SessionServices } from './sessionServices'

function text(args: Record<string, unknown>, key: string, max = 256): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid service ${key}`)
  return value
}
function integer(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error('Invalid service log cursor/limit')
  return value as number
}
export function createServiceRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  const services = new SessionServices()
  options.registerHostDisposer?.(() => services.dispose())
  return {
    async start_session_service(args, invocation) {
      const sessionId = text(args, 'sessionId')
      const command = text(args, 'command', 32768)
      const cwd = args.cwd === undefined ? undefined : text(args, 'cwd', 8192)
      let env: Record<string, string> | undefined
      if (args.env !== undefined) {
        if (!args.env || typeof args.env !== 'object' || Array.isArray(args.env)) throw new Error('Invalid service env')
        const entries = Object.entries(args.env)
        if (entries.length > 128 || entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 8192) || JSON.stringify(args.env).length > 65536) throw new Error('Invalid service env')
        env = Object.fromEntries(entries) as Record<string, string>
      }
      return services.start(sessionId, command, cwd, env, invocation?.signal)
    },
    async get_session_service(args) { return services.status(text(args, 'sessionId'), text(args, 'serviceId')) },
    async read_session_service_logs(args) { return services.logs(text(args, 'sessionId'), text(args, 'serviceId'), integer(args.cursor, 0, Number.MAX_SAFE_INTEGER), Math.max(2, integer(args.maxChars, 16384, 65536))) },
    async stop_session_service(args) { return services.stop(text(args, 'sessionId'), text(args, 'serviceId')) },
    async end_service_session(args) { return services.end(text(args, 'sessionId')) },
  }
}
