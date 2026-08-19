import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostInvoke } from '@einfach-agent/core'
import { createNodeHostInvoke, NodeHostCommandError } from '@einfach-agent/host-node'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_INVOKE_BODY_BYTES } from './invokeRoute'
import { sendInvokeRequest, startInvokeRouteTestServer, type InvokeRouteTestServer } from './invokeRoute.testHarness'

const JSON_HEADERS = { 'content-type': 'application/json' }

describe('createInvokeRouteHandler（桩 invoke，测 handler 自身逻辑）', () => {
  let server: InvokeRouteTestServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('非 POST 回 405，带 allow 头', async () => {
    const stub: HostInvoke = async () => {
      throw new Error('不应被调用')
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(server.port, 'GET', '/api/invoke/get_user_home_dir')
    expect(result.status).toBe(405)
    expect(result.headers.allow).toBe('POST')
    expect(JSON.parse(result.body)).toEqual({
      error: 'method_not_allowed',
      message: '命令调用只接受 POST 请求。',
    })
  })

  it('Content-Type 不是 application/json 回 415，即使是表单能发出的类型', async () => {
    const stub: HostInvoke = async () => {
      throw new Error('不应被调用')
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(server.port, 'POST', '/api/invoke/get_user_home_dir', 'a=1', {
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(result.status).toBe(415)
    expect(JSON.parse(result.body).error).toBe('unsupported_media_type')
  })

  it('缺失 Content-Type 同样回 415', async () => {
    const stub: HostInvoke = async () => {
      throw new Error('不应被调用')
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(server.port, 'POST', '/api/invoke/get_user_home_dir')
    expect(result.status).toBe(415)
  })

  it('空 body 时 args 是 {}，命令名与参数逐字透传给 invoke', async () => {
    const calls: Array<{ command: string, args: Record<string, unknown> | undefined }> = []
    const stub: HostInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      return 'ok' as T
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      undefined,
      JSON_HEADERS,
    )
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toBe('ok')
    expect(calls).toEqual([{ command: 'get_user_home_dir', args: {} }])
  })

  it('body 逐字透传：不改键名大小写、不补默认值、保留显式 null', async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const stub: HostInvoke = async <T>(_command: string, args?: Record<string, unknown>) => {
      calls.push(args)
      return null as T
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/write_workspace_file',
      JSON.stringify({ path: 'a.txt', change_context: { changeId: 'c1' }, expected_content_hash: null }),
      JSON_HEADERS,
    )
    expect(calls).toEqual([{ path: 'a.txt', change_context: { changeId: 'c1' }, expected_content_hash: null }])
  })

  it('invoke 结果为 undefined 时回 200 与 JSON null', async () => {
    const stub: HostInvoke = async () => undefined as never
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      undefined,
      JSON_HEADERS,
    )
    expect(result.status).toBe(200)
    expect(result.body).toBe('null')
  })

  it('数组顶层 body 回 400 invalid_body', async () => {
    const stub: HostInvoke = async () => {
      throw new Error('不应被调用')
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      '[1,2,3]',
      JSON_HEADERS,
    )
    expect(result.status).toBe(400)
    expect(JSON.parse(result.body).error).toBe('invalid_body')
  })

  it('损坏的 JSON 回 400 invalid_json', async () => {
    const stub: HostInvoke = async () => {
      throw new Error('不应被调用')
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      '{not json',
      JSON_HEADERS,
    )
    expect(result.status).toBe(400)
    expect(JSON.parse(result.body).error).toBe('invalid_json')
  })

  it('body 超过上限回 413，且 invoke 从未被调用', async () => {
    let called = false
    const stub: HostInvoke = async <T>() => {
      called = true
      return null as T
    }
    server = await startInvokeRouteTestServer({ invoke: stub, maxBodyBytes: 16 })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      JSON.stringify({ padding: 'x'.repeat(64) }),
      JSON_HEADERS,
    )
    expect(result.status).toBe(413)
    expect(called).toBe(false)
  })

  it('非 NodeHostCommandError 的异常重抛，由外层兜底收成 500', async () => {
    const stub: HostInvoke = async () => {
      throw new Error('意料之外的 bug')
    }
    server = await startInvokeRouteTestServer({ invoke: stub })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      undefined,
      JSON_HEADERS,
    )
    expect(result.status).toBe(500)
  })

  it('默认 body 上限是 32 MiB', () => {
    expect(DEFAULT_MAX_INVOKE_BODY_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe('createInvokeRouteHandler（真实 createNodeHostInvoke，端到端）', () => {
  let server: InvokeRouteTestServer | undefined
  let home: string | undefined
  let savedOverride: string | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
    if (home) {
      await rm(home, { recursive: true, force: true })
      home = undefined
    }
    if (savedOverride === undefined) delete process.env.WEB_AGENT_CONFIG_DIR
    else process.env.WEB_AGENT_CONFIG_DIR = savedOverride
  })

  it('get_user_home_dir 真实路由到 os.homedir()，空 body 也能跑', async () => {
    server = await startInvokeRouteTestServer({ invoke: createNodeHostInvoke() })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get_user_home_dir',
      undefined,
      JSON_HEADERS,
    )
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toBe(homedir())
  })

  // **28 条命令在 M1/C1 之后全部落地**，所以经真实 `createNodeHostInvoke()` 已经构造不出
  // `unimplemented`（原样本 `mcp_list_tools` 现在是实现了的）。501 这条映射仍要留着：路由表是
  // `Partial`，将来 commandNames.ts 新增一条命令而域没跟上时，它就是唯一的报信人。
  // 于是改用一个只会抛 `unimplemented` 的桩——测的本来也就是「reason → 状态码」这一层映射。
  it('宿主报 unimplemented 时回 501', async () => {
    const invoke = (async (command: string) => {
      throw new NodeHostCommandError(command, 'unimplemented')
    }) as HostInvoke
    server = await startInvokeRouteTestServer({ invoke })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/mcp_list_tools',
      JSON.stringify({ serverId: 'x' }),
      JSON_HEADERS,
    )
    expect(result.status).toBe(501)
    const payload = JSON.parse(result.body) as { error: string, message: string }
    expect(payload.error).toBe('command_not_implemented')
    expect(payload.message).toContain('mcp_list_tools')
  })

  it('不在全集里的命令回 404，包括经百分号编码到达的合法命令名', async () => {
    server = await startInvokeRouteTestServer({ invoke: createNodeHostInvoke() })
    const direct = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/not_a_real_command',
      undefined,
      JSON_HEADERS,
    )
    expect(direct.status).toBe(404)
    expect(JSON.parse(direct.body).error).toBe('unknown_command')

    // %5F 解码一次得到 `_`，拼出 get_user_home_dir——证明解码在真实 HTTP 路径上也只做一次，
    // 且解码结果确实被拿去问 host-node（而不是原样比对百分号编码串）。
    // 样本从 mcp_list_tools 换成 get_user_home_dir：C1 落地后前者已实现，200 与 501 都不再能
    // 区分「解码对了」与「解码错了」——而 404 与 200 可以。
    const encoded = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/get%5Fuser%5Fhome%5Fdir',
      '{}',
      JSON_HEADERS,
    )
    expect(encoded.status).toBe(200) // 解码后是登记在册且已实现的命令，不是 404
  })

  it('mcp_config_read 隔离到临时主目录后能跑通（顺带证明 homeDir 装配槽生效）', async () => {
    home = await mkdtemp(join(tmpdir(), 'web-agent-invoke-route-'))
    savedOverride = process.env.WEB_AGENT_CONFIG_DIR
    process.env.WEB_AGENT_CONFIG_DIR = join(home, 'config')
    server = await startInvokeRouteTestServer({ invoke: createNodeHostInvoke({ homeDir: home }) })
    const result = await sendInvokeRequest(
      server.port,
      'POST',
      '/api/invoke/mcp_config_read',
      undefined,
      JSON_HEADERS,
    )
    expect(result.status).toBe(200)
  })
})
