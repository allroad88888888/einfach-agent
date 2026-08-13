// 透明连接 execute 的用例共用替身：一份真的 ToolRegistry + 占位登记表、一个可脚本化的
// manager（登记表 + reconnect），以及把它们按【生产接法】接起来的 setup。
//
// 两条刻意的口径：
//   · 占位由 createMcpPlaceholderTool 真造出来并注册进 registry，调用一律经 registry.run 进去
//     ——判据因此测的是模型真正会走的那条路，而不是一个只在测试里存在的形状；
//   · 连接成功的默认脚本会像真 manager 那样走完 reconcile（真实工具原地覆盖同名占位、占位登记
//     释放、远端已消失的占位被注销），所以「委派到的是真实工具」不是靠断言凑出来的。

import { createToolRegistry } from '@web-agent/core/tools'
import type { Tool, ToolContext } from '@web-agent/core/tools'
import { vi } from 'vitest'
import { createMcpPlaceholderClaims } from './placeholderClaims'
import { createMcpPlaceholderExecutor } from './placeholderExecute'
import { createMcpPlaceholderTool } from './placeholderTool'
import { makeMcpToolName } from './toolAdapter'
import type {
  McpOperationOptions,
  McpServerSnapshot,
  McpServerStatus,
  McpToolSnapshot,
} from './types'

export const SERVER_ID = 'docs'
export const TOOL_NAME = makeMcpToolName(SERVER_ID, 'search')
/** 远端改名后的新名字：缓存里没有它，真实清单里只有它。 */
export const RENAMED_TOOL_NAME = makeMcpToolName(SERVER_ID, 'search_v2')

/** 连上之后远端给的真实工具：inputSchema 有真参数，占位的透传 schema 没有。 */
export function realTool(name = TOOL_NAME): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `真实的 ${name}`, content: '真实指南' },
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    execute: (args) => ({ ok: true, data: { ranWith: args } }),
  }
}

function toSnapshot(tool: Tool): McpToolSnapshot {
  return {
    name: tool.name,
    remoteName: tool.name,
    description: tool.skill.description,
    inputSchema: tool.inputSchema,
  }
}

export interface PlaceholderConnectControls {
  /** 走完 manager 连接成功路径里的那一段：reconcile + 记录转 connected。 */
  reconcile(real: readonly Tool[]): void
  /** 只把记录标成 connected，registry 一个字不改——用来构造「占位还占着这个名字」的异常态。 */
  markConnected(): void
}

export interface SetupPlaceholderExecuteOptions {
  /** 登记表里这条记录此刻的状态。 */
  status?: McpServerStatus
  /** 记录已经不在登记表里（服务被删了）。 */
  removed?: boolean
  connectTimeoutMs?: number
  /** 一次连接会发生什么。默认：连上并 reconcile 出同名真实工具。 */
  connect?(
    controls: PlaceholderConnectControls,
    options?: McpOperationOptions,
  ): void | Promise<void>
}

export function setupPlaceholderExecute(options: SetupPlaceholderExecuteOptions = {}) {
  const registry = createToolRegistry()
  const claims = createMcpPlaceholderClaims()
  let record: McpServerSnapshot | undefined = options.removed
    ? undefined
    : {
        id: SERVER_ID,
        // stdio：起进程确认那条链路在 execute 之前（D3a），这里只是让 transport 不是默认值，
        // 好证明失败回执里的 transport 取自登记表而不是写死。
        config: { id: SERVER_ID, transport: 'stdio', command: 'npx', args: ['-y', '@docs/mcp'] },
        status: options.status ?? 'disconnected',
        tools: [],
      }

  const controls: PlaceholderConnectControls = {
    reconcile(real) {
      for (const name of claims.namesFor(SERVER_ID)) {
        if (real.some((tool) => tool.name === name)) continue
        const placeholder = claims.get(name)?.tool
        if (!placeholder) continue
        // 服务一旦 connected 占位集合恒为空：同步器把远端已经没有的那些注销掉（expected 形式）。
        registry.unregister(name, placeholder)
        claims.release(name, placeholder)
      }
      for (const tool of real) {
        // 真实工具原地覆盖同名占位，登记随之作废（toolReconciler 的 mutate 阶段）。
        registry.register(tool)
        const claimed = claims.get(tool.name)
        if (claimed) claims.release(tool.name, claimed.tool)
      }
      controls.markConnected()
      record = { ...record!, tools: real.map(toSnapshot) }
    },
    markConnected() {
      record = { ...record!, status: 'connected' }
    },
  }

  const connect = options.connect ?? ((ctl: PlaceholderConnectControls) => {
    ctl.reconcile([realTool()])
  })
  const reconnect = vi.fn(
    async (_serverId: string, connectOptions?: McpOperationOptions): Promise<McpServerSnapshot> => {
      await connect(controls, connectOptions)
      return record!
    },
  )

  const manager = { get: (id: string) => (id === SERVER_ID ? record : undefined), reconnect }
  const executor = createMcpPlaceholderExecutor({
    registry,
    manager,
    claims,
    ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
  })

  const placeholder = createMcpPlaceholderTool({
    serverId: SERVER_ID,
    entry: { name: TOOL_NAME, description: '上次已知的搜索工具' },
    runtime: 'internal',
    executor,
  })
  registry.register(placeholder)
  claims.claim(SERVER_ID, TOOL_NAME, placeholder)
  // 已连接的世界里占位早就被 reconcile 换掉了；这里补上那一步，测试才不必自己摆状态。
  if (!options.removed && (options.status ?? 'disconnected') === 'connected') {
    controls.reconcile([realTool()])
  }

  const runSpy = vi.spyOn(registry, 'run')

  return {
    registry,
    claims,
    manager,
    reconnect,
    placeholder,
    runSpy,
    record: () => record,
    /** 模型的一次调用：和生产一样从 registry.run 进去，先过占位的透传 schema。 */
    call: (args: unknown, ctx: ToolContext) => registry.run(TOOL_NAME, args, ctx),
  }
}

export function placeholderContext() {
  const controller = new AbortController()
  const progress = vi.fn()
  const callTool = vi.fn(async () => ({ ok: true }))
  const ctx = { signal: controller.signal, progress, callTool } as unknown as ToolContext
  return { ctx, progress, callTool, abort: () => controller.abort(new Error('user cancelled')) }
}
