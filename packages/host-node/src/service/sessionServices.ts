import { randomUUID } from 'node:crypto'
import { currentPlatform, resolveShell, resolveCwd } from '../shell/platform'
import { ServiceLogBuffer } from './logBuffer'
import { launchService } from './process'

type RunningProcess = ReturnType<typeof launchService>
interface Entry {
  id: string; sessionId: string; state: string; startedAt: number
  exitCode: number | null; signal: string | null; logs: ServiceLogBuffer
  cleaned?: boolean; process?: RunningProcess; pending?: Promise<unknown>; stopReason?: string
}
/** Owns the lifecycle of every session service in one host. */
export class SessionServices {
  private entries = new Map<string, Entry>()
  private ended = new Set<string>()
  private closed = false
  private assertOpen(sessionId: string) {
    if (this.ended.size >= 100000) throw new Error('Service session history limit reached; restart the host to start new services')
    if (this.closed || this.ended.has(sessionId)) throw new Error('Service session is closed')
  }
  private entry(sessionId: string, id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry || entry.sessionId !== sessionId) throw new Error('Unknown service')
    return entry
  }
  status(sessionId: string, id: string) {
    const { state, startedAt, exitCode, signal, stopReason } = this.entry(sessionId, id)
    return { serviceId: id, state, startedAt, exitCode, signal, stopReason }
  }
  logs(sessionId: string, id: string, cursor: number, maxChars: number) {
    return this.entry(sessionId, id).logs.read(cursor, maxChars)
  }
  async start(sessionId: string, command: string, cwd?: string, env?: Record<string, string>, signal?: AbortSignal) {
    this.assertOpen(sessionId)
    if (process.platform === 'win32') throw new Error('Session services are unsupported on Windows: reliable process-tree cleanup is unavailable')
    // Completed records are FIFO bounded; running processes are never evicted.
    for (const [id, entry] of this.entries) {
      if (this.entries.size < 128) break
      if (entry.cleaned) this.entries.delete(id)
    }
    if (this.entries.size >= 128 || [...this.entries.values()].filter(e => e.sessionId === sessionId && ['starting', 'running'].includes(e.state)).length >= 8) throw new Error('Service capacity reached')
    const entry: Entry = { id: randomUUID(), sessionId, state: 'starting', startedAt: Date.now(), exitCode: null, signal: null, logs: new ServiceLogBuffer() }
    this.entries.set(entry.id, entry)
    const pending = (async () => {
      try {
        const platform = currentPlatform()
        if (platform !== 'macos' && platform !== 'linux') throw new Error('Unsupported service platform')
        const shell = await resolveShell(platform)
        const directory = await resolveCwd(cwd)
        this.assertOpen(sessionId)
        signal?.throwIfAborted()
        const process = launchService(shell.program, [...shell.args, command], directory, env, entry.logs)
        entry.process = process
        process.child.once('exit', (code, exitSignal) => {
          entry.exitCode = code; entry.signal = exitSignal
          if (entry.state !== 'stopped') entry.state = code === 0 ? 'exited' : 'failed'
          void process.stop().then(() => { entry.cleaned = true }).catch(() => { entry.state = 'cleanup_failed' })
        })
        const abort = () => { void process.stop().catch(() => {}) }
        signal?.addEventListener('abort', abort, { once: true })
        try {
          await process.ready
          this.assertOpen(sessionId)
          signal?.throwIfAborted()
          if (entry.state === 'starting') entry.state = 'running'
        } finally { signal?.removeEventListener('abort', abort) }
        return this.status(sessionId, entry.id)
      } catch (error) {
        entry.state = 'failed'
        await entry.process?.stop()
        this.entries.delete(entry.id)
        throw error
      }
    })()
    entry.pending = pending
    return pending
  }
  async stop(sessionId: string, id: string, reason = 'requested') {
    const entry = this.entry(sessionId, id)
    await entry.process?.stop()
    entry.state = 'stopped'; entry.stopReason = reason; entry.cleaned = true
    return this.status(sessionId, id)
  }
  async end(sessionId: string) {
    // Never recycle tombstones: delayed HTTP starts must not resurrect a deleted session.
    if (!this.ended.has(sessionId)) {
      if (this.ended.size >= 100000) { this.closed = true }
      else this.ended.add(sessionId)
    }
    await Promise.all([...this.entries.values()].filter(e => e.sessionId === sessionId).map(async entry => {
      await entry.pending?.catch(() => {})
      if (this.entries.has(entry.id)) await this.stop(sessionId, entry.id, 'session_ended')
      this.entries.delete(entry.id)
    }))
    return { ended: true }
  }
  async dispose() {
    this.closed = true
    await Promise.all([...new Set([...this.entries.values()].map(e => e.sessionId))].map(id => this.end(id)))
  }
}
