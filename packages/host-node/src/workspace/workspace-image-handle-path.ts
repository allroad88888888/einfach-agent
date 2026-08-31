import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const LSOF_PATH = '/usr/sbin/lsof'
const HANDLE_PATH_ERROR = 'cannot verify opened image path'

export interface WorkspaceImageHandlePathDependencies {
  platform: NodeJS.Platform
  pid: number
  realpath(path: string): Promise<string>
  execFile(file: string, args: readonly string[]): Promise<string>
}

function runExecFile(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024, shell: false, timeout: 2_000 },
      (error, stdout, stderr) => error || stderr.length > 0 ? reject(error ?? new Error('lsof stderr')) : resolve(stdout),
    )
  })
}

const defaultDependencies: WorkspaceImageHandlePathDependencies = {
  platform: process.platform,
  pid: process.pid,
  realpath,
  execFile: runExecFile,
}

function validateHandlePath(value: string): string {
  if (
    !isAbsolute(value)
    || value.endsWith(' (deleted)')
    || value.includes('\n')
    || value.includes('\\')
  ) {
    throw new Error(HANDLE_PATH_ERROR)
  }
  return value
}

function parseLsof(stdout: string, pid: number, fd: number): string {
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n')
  if (lines.length !== 3) throw new Error(HANDLE_PATH_ERROR)
  if (lines[0] !== `p${pid}` || lines[1] !== `f${fd}` || !lines[2]?.startsWith('n')) {
    throw new Error(HANDLE_PATH_ERROR)
  }
  return validateHandlePath(lines[2].slice(1))
}

export async function resolveWorkspaceImageHandlePath(
  fd: number,
  dependencies: WorkspaceImageHandlePathDependencies = defaultDependencies,
): Promise<string> {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error(HANDLE_PATH_ERROR)
  try {
    if (dependencies.platform === 'linux') {
      return validateHandlePath(await dependencies.realpath(`/proc/self/fd/${fd}`))
    }
    if (dependencies.platform === 'darwin') {
      if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 0) {
        throw new Error(HANDLE_PATH_ERROR)
      }
      const args = ['-a', '-p', String(dependencies.pid), '-d', String(fd), '-Fn'] as const
      return parseLsof(await dependencies.execFile(LSOF_PATH, args), dependencies.pid, fd)
    }
    throw new Error(HANDLE_PATH_ERROR)
  } catch {
    throw new Error(HANDLE_PATH_ERROR)
  }
}
