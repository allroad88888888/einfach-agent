import { createNodeHostInvoke } from '@einfach-agent/host-node'
import { installCliShutdown } from './shutdown'

const shutdown = installCliShutdown()
const invoke = createNodeHostInvoke({ registerHostDisposer: shutdown.registerHostDisposer })
const code = "console.log(process.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
const started = await invoke<{ serviceId: string }>('start_session_service', { sessionId: 'signal-test', command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}` })
for (;;) {
  const logs = await invoke<{ text: string }>('read_session_service_logs', { sessionId: 'signal-test', serviceId: started.serviceId })
  if (logs.text.trim()) { process.stdout.write(`READY ${logs.text.trim()}\n`); break }
  await new Promise(r => setTimeout(r, 10))
}
