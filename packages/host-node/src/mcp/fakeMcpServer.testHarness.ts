// 假 MCP server 的定位与入参样板
// ---------------------------------------------------------------------------
// 测试里 spawn 的**只能**是本仓库自己写的 fakeMcpServer.cjs，绝不去装或跑任何第三方 MCP
// 实现——那既是网络依赖，也意味着测试结果取决于别人当天发了什么版本。

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expect } from 'vitest'

/**
 * 从 cwd 往上找 pnpm-workspace.yaml 定位仓库根。
 *
 * **不能用 `import.meta.url`**：Vitest 走 Vite 的模块图，jsdom 环境下它是 `http://` 而不是
 * `file://`，`fileURLToPath` 当场抛「The URL must be of scheme file」。
 * （与 commandNames.test.ts 里那段同一个理由、同一个解法。）
 */
function repositoryRoot(): string {
  let current = process.cwd()
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current)
    expect(parent, '从 cwd 往上找不到 pnpm-workspace.yaml').not.toBe(current)
    current = parent
  }
  return current
}

export const FAKE_MCP_SERVER_PATH = resolve(
  repositoryRoot(),
  'packages/host-node/src/mcp/fakeMcpServer.cjs',
)

export interface FakeServerOptions {
  serverId: string
  mode: string
  sessionToken?: string
  requestTimeoutMs?: number
  toolCount?: number
  /** 追加在 mode / toolCount 之后的实参。`argv` 模式会把它们原样回传。 */
  extraArgs?: readonly string[]
}

/** 一份指向假 server 的 `mcp_connect` 入参（外层 `input` 那一层也在内）。 */
export function fakeConnectArgs(options: FakeServerOptions): Record<string, unknown> {
  return {
    input: {
      serverId: options.serverId,
      sessionToken: options.sessionToken ?? `${options.serverId}-session`,
      command: process.execPath,
      args: [
        FAKE_MCP_SERVER_PATH,
        options.mode,
        String(options.toolCount ?? 1000),
        ...(options.extraArgs ?? []),
      ],
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    },
  }
}

/** 进程还在不在。用于断言「测试没有漏掉子进程」。 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等一个条件成立，最多等 `timeoutMs`；到点即断言失败（而不是静默继续）。 */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) expect.fail(`超时未满足：${message}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
