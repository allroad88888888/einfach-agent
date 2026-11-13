import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createWebAgentServer } from './createServer'
import { sendInvokeRequest } from './invokeRoute.testHarness'

describe.skipIf(process.platform === 'win32')('HTTP session services', () => {
  it('authenticates start/log/status/stop/end through the actual server and disposes', async () => {
    const disposers: Array<() => Promise<void>> = []
    const server = createWebAgentServer({ token: 'service-test', registerHostDisposer: d => disposers.push(d), onInternalError: () => {} })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const invoke = async (command: string, args: Record<string, unknown>, auth = true) => {
      const result = await sendInvokeRequest(port, 'POST', `/api/invoke/${command}`, JSON.stringify(args), { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer service-test' } : {}) })
      return { status: result.status, data: result.status === 200 ? JSON.parse(result.body) : result.body }
    }
    try {
      expect((await invoke('start_session_service', { sessionId: 'a', command: 'true' }, false)).status).toBe(401)
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('ready');setInterval(()=>{},1000)")}`
      const started = await invoke('start_session_service', { sessionId: 'a', command })
      expect(started.status).toBe(200)
      const serviceId = started.data.serviceId
      expect((await invoke('get_session_service', { sessionId: 'b', serviceId })).status).toBe(502)
      let logs
      for (let i = 0; i < 80; i++) {
        logs = await invoke('read_session_service_logs', { sessionId: 'a', serviceId })
        if (logs.data.text.includes('ready')) break
        await new Promise(r => setTimeout(r, 20))
      }
      expect(logs?.data.text).toContain('ready')
      expect((await invoke('stop_session_service', { sessionId: 'a', serviceId })).data.state).toBe('stopped')
      await invoke('start_session_service', { sessionId: 'a', command })
      expect((await invoke('end_service_session', { sessionId: 'a' })).data).toEqual({ ended: true })
      expect((await invoke('start_session_service', { sessionId: 'a', command })).status).toBe(502)
      const live = await invoke('start_session_service', { sessionId: 'c', command })
      await Promise.all(disposers.map(d => d()))
      expect((await invoke('get_session_service', { sessionId: 'c', serviceId: live.data.serviceId })).status).toBe(502)
      expect((await invoke('start_session_service', { sessionId: 'd', command })).status).toBe(502)
    } finally {
      await Promise.all(disposers.map(d => d()))
      server.close(); await once(server, 'close')
    }
  })
})
