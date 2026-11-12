import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ServiceLogBuffer } from './logBuffer'

const tracked = new Set<number>()
function kill(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
function exitCleanup() { for (const pid of tracked) { try { kill(pid, 'SIGKILL') } catch {} } }
export function launchService(program: string, args: string[], cwd: string, env: Record<string, string> | undefined, logs: ServiceLogBuffer) {
  const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid) {
    if (!tracked.size) process.on('exit', exitCleanup)
    tracked.add(child.pid)
  }
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8')
    stream.on('data', (chunk: Buffer) => logs.append(decoder.write(chunk)))
    stream.on('end', () => logs.append(decoder.end()))
  }
  const ready = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.on('error', () => {})
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    if (child.pid) {
      kill(child.pid, 'SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 150))
      kill(child.pid, 'SIGKILL')
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 300))])
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error('Service process did not exit after SIGKILL')
      tracked.delete(child.pid)
      if (!tracked.size) process.removeListener('exit', exitCleanup)
    }
    child.stdout.destroy()
    child.stderr.destroy()
  })().catch(error => { stopping = undefined; throw error })
  return { child: child as ChildProcess, ready, stop }
}
