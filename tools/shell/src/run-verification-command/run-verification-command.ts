// tools/run-verification-command/run-verification-command.ts —— 验证命令执行器。
// ---------------------------------------------------------------------------
// 仅验证子 agent 的 workspace_verify profile 会暴露本工具；命令本身不受发现结果限制，
// 因此可执行项目自己的验收脚本。副作用仍只经 ctx.runShell，与 shell_* 共用同一条
// workspace confinement / 超时 / 截断通道。
import type { Tool } from '@web-agent/core/tools'
import { detectHostPlatform } from '@web-agent/core/runtime/hostPlatform'
import { shellCommandToolResult } from '../command-result'
import guide from './run-verification-command.md?raw'

const TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 100_000

const inputSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      description: 'A non-empty shell command needed to verify the stage objective.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'runShell failed'
}

export const runVerificationCommandTool: Tool = {
  name: 'run_verification_command',
  runtime: 'server', // 依赖 Tauri 本机 shell（ctx.runShell），web 下不进 manifest（TP3）。
  replayUnsafe: true,
  skill: {
    description: '执行验收所需的本机 shell 命令，为验收标准取得真实执行证据。',
    triggers: ['verify', 'verification', 'run test', 'run lint', '验收', '核验', '执行证据'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) {
      return {
        ok: false,
        error: 'invalid run_verification_command: command (non-empty string) is required',
        code: 'VERIFICATION_INVALID_INPUT',
        retryable: false,
      }
    }

    if (typeof ctx.runShell !== 'function') {
      return {
        ok: false,
        error: 'run_verification_command unavailable: shell unavailable in this runtime',
        code: 'VERIFICATION_SHELL_UNAVAILABLE',
        retryable: false,
      }
    }

    try {
      ctx.progress(`核验命令: ${command.slice(0, 120)}`)
      const result = await ctx.runShell({
        // Rust 桥会拒绝与宿主不一致的 platform，命令参数本身没有平台信息，
        // 所以从运行环境推断；与注入给模型的「运行环境」段共用同一个探测函数。
        platform: detectHostPlatform(),
        command,
        timeoutMs: TIMEOUT_MS,
        maxOutputChars: MAX_OUTPUT_CHARS,
      })
      // web（无 Tauri 桥）与桥调用失败都会回 shell:'unavailable'。那不是"命令失败"这条证据，
      // 必须显性区分：否则评估器会把"根本没跑成"读成"验收标准不成立"。
      if (result.shell === 'unavailable') {
        return {
          ok: false,
          error: 'run_verification_command unavailable: shell unavailable in this runtime',
          code: 'VERIFICATION_SHELL_UNAVAILABLE',
          retryable: false,
          details: result,
        }
      }
      // 非零退出码是【有效的验收证据】，不是工具故障；但仍按仓库统一口径回 ok:false + details，
      // 让评估器读到 exitCode/stdout/stderr 后自己下判断。
      return shellCommandToolResult(result)
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
        code: 'VERIFICATION_EXECUTION_ERROR',
        retryable: true,
      }
    }
  },
}
