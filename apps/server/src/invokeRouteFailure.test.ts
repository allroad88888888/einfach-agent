// 「命令自己失败了」在这条路由上长什么样——各域一条，走真实 `createNodeHostInvoke()` + 真实 HTTP。
// ---------------------------------------------------------------------------
// C6 之前，下面每一条都是同一个答复：`text/plain` 的 500「服务端内部错误。」，外加一份堆栈被
// 当作「预期外异常」写进 server 的 stderr。两件事因此同时坏掉：
//   ① MCP 的 `kind` 丢了 → `tools/mcp` 的失败分类器只认 kind，拿不到就落「可重试」，于是
//      `command_spawn_failed`（桌面宿主上是**永久**失败）在 server 宿主上被无限退避重连；
//   ② 各域写好的那句话丢了 → 客户端只剩「本地服务返回了非预期的错误响应（HTTP 500）」。
//
// 用例**故意跨四个域**：这条路上有 30 条命令，只给 MCP 修等于给它开特例。各域实际的失败载体
// 是不一样的（mcp 有 `kind`、model 有 `reason`、其余是等价移植 Rust `Err(String)` 的裸 Error），
// 所以断言分两档：**都**要求「命令失败档的状态码 + 那句话原样到达」，有标识的那两个域再加一条
// 「标识带得出」。

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeHostInvoke, SQLITE_CONNECTION_NAMES } from '@einfach-agent/host-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_FAILURE_STATUS, UNCLASSIFIED_COMMAND_FAILURE } from './invokeRouteError'
import { sendInvokeRequest, startInvokeRouteTestServer, type InvokeRouteTestServer } from './invokeRoute.testHarness'
import { startTestServer, type TestServerHandle } from './testServer.testHarness'

const JSON_HEADERS = { 'content-type': 'application/json' }

interface FailureEnvelope {
  readonly error: string
  readonly message: string
}

let home: string
let workspace: string
let routeServer: InvokeRouteTestServer | undefined
let fullServer: TestServerHandle | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-invoke-failure-home-'))
  // 空目录：主会话在真浏览器里撞到的那一幕就发生在新建的空工作区上。
  workspace = await mkdtemp(join(tmpdir(), 'web-agent-invoke-failure-ws-'))
})

afterEach(async () => {
  await routeServer?.close()
  routeServer = undefined
  await fullServer?.close()
  fullServer = undefined
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

async function failCommand(command: string, args: Record<string, unknown>): Promise<{
  status: number
  contentType: string
  envelope: FailureEnvelope
}> {
  routeServer = await startInvokeRouteTestServer({ invoke: createNodeHostInvoke({ homeDir: home }) })
  const result = await sendInvokeRequest(
    routeServer.port,
    'POST',
    `/api/invoke/${command}`,
    JSON.stringify(args),
    JSON_HEADERS,
  )
  return {
    status: result.status,
    contentType: String(result.headers['content-type'] ?? ''),
    envelope: JSON.parse(result.body) as FailureEnvelope,
  }
}

describe('业务失败带得出结构化标识（四个域各一条）', () => {
  // mcp：唯一一个**标识本身是契约**的域。这条正是卡面复现的那一次调用。
  it('mcp_list_tools 入参不合法 → 命令失败档 + McpCommandError.kind', async () => {
    const failure = await failCommand('mcp_list_tools', {})
    expect(failure.status).toBe(COMMAND_FAILURE_STATUS)
    expect(failure.contentType).toContain('application/json')
    expect(failure.envelope.error).toBe('invalid_input')
    expect(failure.envelope.message.length).toBeGreaterThan(0)
  })

  // sqlite：P3 点名的那一侧。没有 kind，但那句准确的中文必须原样到达。
  it('sqlite_select 的 sql 为空 → 命令失败档 + 原话', async () => {
    const failure = await failCommand('sqlite_select', {
      connection: SQLITE_CONNECTION_NAMES[0],
      sql: '   ',
    })
    expect(failure.status).toBe(COMMAND_FAILURE_STATUS)
    expect(failure.envelope.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
    expect(failure.envelope.message).toBe('sqlite 命令的 sql 必须是非空字符串')
  })

  // workspace：主会话在真浏览器里撞到的那一类（可选目录探测，ENOENT）。
  it('list_workspace_files 指向不存在的路径 → 命令失败档 + 原话', async () => {
    const failure = await failCommand('list_workspace_files', {
      workspace_root: workspace,
      path: '.webAgent/skills',
    })
    expect(failure.status).toBe(COMMAND_FAILURE_STATUS)
    expect(failure.envelope.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
    expect(failure.envelope.message).toContain('.webAgent/skills')
    expect(failure.envelope.message).toContain('is not accessible')
  })

  // shell：`run_shell_command` 的入参收窄。
  it('run_shell_command 缺参数 → 命令失败档 + 原话', async () => {
    const failure = await failCommand('run_shell_command', {})
    expect(failure.status).toBe(COMMAND_FAILURE_STATUS)
    expect(failure.envelope.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
    expect(failure.envelope.message).toBe('run_shell_command 缺少 platform 参数')
  })

  // config：与 mcp 域同名前缀但**不是**同一个域（`mcp_config_*` 读的是 config.json）。
  it('mcp_config_write 缺 patch → 命令失败档 + 原话', async () => {
    const failure = await failCommand('mcp_config_write', {})
    expect(failure.status).toBe(COMMAND_FAILURE_STATUS)
    expect(failure.envelope.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
    expect(failure.envelope.message).toBe('mcp_config_write 缺少 patch 参数')
  })

  // 分发失败不是命令失败：这两档必须继续分得开，否则「命令名拼错了」会被当成「命令跑了但拒绝了」。
  it('命令名不存在仍然是 404，不落命令失败档', async () => {
    const failure = await failCommand('not_a_real_command', {})
    expect(failure.status).toBe(404)
    expect(failure.envelope.error).toBe('unknown_command')
  })
})

describe('业务失败不再被当作「预期外异常」上报（整台 server）', () => {
  const TOKEN = 'invoke-failure-token-0123456789'

  it('list_workspace_files 探到不存在的目录：JSON 信封 + onInternalError 一次都没响', async () => {
    const reported: unknown[] = []
    fullServer = await startTestServer({
      token: TOKEN,
      homeDir: home,
      version: '0.0.0-test',
      onInternalError: (error) => { reported.push(error) },
    })
    const result = await sendInvokeRequest(
      fullServer.port,
      'POST',
      '/api/invoke/list_workspace_files',
      JSON.stringify({ workspace_root: workspace, path: '.claude/skills' }),
      { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` },
    )
    expect(result.status).toBe(COMMAND_FAILURE_STATUS)
    expect(String(result.headers['content-type'])).toContain('application/json')
    const envelope = JSON.parse(result.body) as FailureEnvelope
    expect(envelope.message).toContain('.claude/skills')
    // 改之前这里是三份完整堆栈：`requestRouter.ts` 的 reportError 把「按设计拒绝」当成 bug 记账，
    // 真出问题时的那一条会被它们淹掉。
    expect(reported).toEqual([])
  })
})

describe('跨端契约：命令失败档的状态码两边必须是同一个数', () => {
  // C4 的客户端那一半（`apps/web/src/mcp/serverMcpCommands.ts`）只在这个状态码上把信封的 `error`
  // 认成 `McpCommandError.kind`。两边分叉的症状是**没有症状**——kind 恒为 undefined，全部 MCP
  // 失败退回「可重试」，无限重连，而 apps/web 的用例喂的是写死状态码的假 fetch，一条都不会红。
  //
  // 这里读**源码文本**而不是 import：apps/server 不依赖 apps/web（app 对 app 不成立的方向），
  // 而文本对拍足以钉住这个数。同样的手法见 modelRouteErrorMessageGuard.test.ts 读 host-node 文案。
  const CLIENT_FILE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'web/src/mcp/serverMcpCommands.ts',
  )

  it('客户端的 MCP_COMMAND_FAILURE_STATUS 与服务端的命令失败档相等', () => {
    const source = readFileSync(CLIENT_FILE, 'utf8')
    const match = /MCP_COMMAND_FAILURE_STATUS\s*=\s*(\d+)/.exec(source)
    // 匹配不到就是客户端那半边改名/挪走了——那时这条守卫本身失效，必须当场红而不是恒绿。
    expect(match?.[1]).toBeDefined()
    expect(Number(match?.[1])).toBe(COMMAND_FAILURE_STATUS)
  })
})
