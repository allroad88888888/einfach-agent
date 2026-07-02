// tools/shell-powershell/shell-powershell.ts —— PowerShell 工具。副作用只经 ctx.runShell。
import type { Tool } from '../types'
import guide from './shell-powershell.md?raw'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 20_000
const MAX_OUTPUT_CHARS = 100_000

const inputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    cwd: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
    maxOutputChars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_OUTPUT_CHARS,
      default: DEFAULT_MAX_OUTPUT_CHARS,
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['command'],
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(Math.floor(value), max)
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const env: Record<string, string> = {}
  for (const [key, envValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof envValue === 'string') {
      env[key] = envValue
    }
  }
  return env
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'runShell failed'
}

export const shellPowershellTool: Tool = {
  name: 'shell_powershell',
  runtime: 'internal',
  skill: {
    description: '在本机 PowerShell 中执行非交互命令。',
    triggers: ['shell', 'powershell', 'pwsh', '命令行', '终端'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) {
      return {
        ok: false,
        error: 'invalid shell_powershell: command (non-empty string) is required',
      }
    }

    const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined
    const timeoutMs = normalizePositiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const maxOutputChars = normalizePositiveInteger(
      input.maxOutputChars,
      DEFAULT_MAX_OUTPUT_CHARS,
      MAX_OUTPUT_CHARS,
    )
    const env = normalizeEnv(input.env)

    try {
      const result = await ctx.runShell({
        platform: 'windows',
        command,
        cwd,
        timeoutMs,
        maxOutputChars,
        env,
      })
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
