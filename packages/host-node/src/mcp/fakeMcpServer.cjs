// 测试用的假 MCP server —— 本仓库自己写的，绝不下载或运行任何第三方 MCP 实现
// ---------------------------------------------------------------------------
// 按 argv[2] 的 mode 决定行为。它是**故意手写**协议而不是用 SDK：几个模式要产生的正是 SDK
// 不会产生的东西——把一条消息劈成多个 write（半包）、把多条消息挤进一个 write（粘包）、
// 在 UTF-8 字符中间切断、回一个不受支持的版本、干脆不回。
//
// 退出约定：默认在 stdin EOF 时自然退出（readline 的 'close'），`stubborn` 模式故意赖着不走，
// 用来验证「grace 用尽后整组强杀」这条路。

const readline = require('node:readline')

const mode = process.argv[2] ?? 'functional'
const toolCount = Number(process.argv[3] ?? '1000')

/** 一次性整条写出（正常路径）。 */
function writeLine(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 逐字节写出：把一条消息劈成 N 个 chunk，且切点可能落在 UTF-8 多字节字符中间。 */
function writeByteByByte(message) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
  for (const byte of bytes) process.stdout.write(Buffer.from([byte]))
}

function respond(id, result) {
  writeLine({ jsonrpc: '2.0', id, result })
}

function initializeResult() {
  if (mode === 'unsupported') {
    return {
      protocolVersion: '2099-01-01',
      capabilities: { tools: {} },
      serverInfo: { name: 'future-server', version: '1.0.0' },
    }
  }
  if (mode === 'resources-only') {
    return {
      protocolVersion: '2025-11-25',
      capabilities: { resources: {} },
      serverInfo: { name: 'resources-only-server', version: '1.0.0' },
    }
  }
  if (mode === 'no-server-info-name') {
    return {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: '   ', version: '1.0.0' },
    }
  }
  return {
    protocolVersion: '2025-11-25',
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'fake-server', version: '1.0.0', title: null },
    instructions: 'test server',
  }
}

function toolPage(cursor) {
  if (mode === 'tool-limit') {
    return cursor === 'overflow'
      ? { tools: [{ name: 'one-too-many', inputSchema: { type: 'object' } }] }
      : {
          tools: Array.from({ length: toolCount }, (_, index) => ({
            name: `tool-${index}`,
            inputSchema: { type: 'object' },
          })),
          nextCursor: 'overflow',
        }
  }
  if (mode === 'repeat-cursor') {
    return { tools: [{ name: 'looping', inputSchema: { type: 'object' } }], nextCursor: 'same' }
  }
  if (cursor === 'next') {
    return { tools: [{ name: 'second', inputSchema: { type: 'object' }, description: null }] }
  }
  return {
    tools: [{ name: 'first', description: '第一页', inputSchema: { type: 'object' } }],
    nextCursor: 'next',
  }
}

function handleInitialize(request) {
  if (mode === 'packed') {
    // 粘包：三条消息挤进**一次** write —— 一条通知、一条服务端请求、一条真正的响应。
    process.stdout.write(
      [
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: '启动' } }),
        JSON.stringify({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' }),
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: initializeResult() }),
      ].join('\n') + '\n',
    )
    return
  }
  if (mode === 'split') {
    // 半包 + UTF-8 跨 chunk：整条响应逐字节写出，`第一页` 的每个汉字都会被切开。
    writeByteByByte({ jsonrpc: '2.0', id: request.id, result: initializeResult() })
    return
  }
  writeLine({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'startup' } })
  respond(request.id, initializeResult())
  process.stderr.write('server diagnostic\n')
}

function handleRequest(request) {
  if (request.method === 'initialize') {
    handleInitialize(request)
    return
  }

  if (request.method === 'notifications/initialized') {
    if (mode === 'exiting') process.exit(7)
    if (mode === 'list-changed') {
      writeLine({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    return
  }

  if (mode === 'timeout') return // 什么都不回，用来验证请求超时

  if (request.method === 'tools/list') {
    if (mode === 'split') {
      writeByteByByte({ jsonrpc: '2.0', id: request.id, result: toolPage(request.params?.cursor) })
      return
    }
    // 顺手插一条服务端 ping 请求：验证客户端会回它，且不会把它当成自己那条请求的响应。
    writeLine({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' })
    respond(request.id, toolPage(request.params?.cursor))
    return
  }

  if (request.method === 'tools/call') {
    if (mode === 'argv') {
      // 把 argv[4] 之后的实参原样回给测试：用来证明它们是**逐个 argv 条目**到达的，
      // 既没有被 shell 解释，也没有被空白拆词。
      respond(request.id, {
        content: [{ type: 'text', text: JSON.stringify(process.argv.slice(4)) }],
      })
      return
    }
    if (mode === 'rpc-error') {
      writeLine({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'tool exploded', data: { detail: 'x' } },
      })
      return
    }
    if (mode === 'malformed-line') {
      // 半条 JSON + 一条完整响应，验证畸形行只丢它自己、不影响后面的消息。
      process.stdout.write('{ not json at all\n')
      respond(request.id, { content: [{ type: 'text', text: 'survived' }] })
      return
    }
    respond(request.id, {
      content: [{ type: 'text', text: 'called' }],
      structuredContent: { ok: true },
      isError: false,
      _meta: null,
    })
    return
  }

  if (request.method === 'client/unsupported') return
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  try {
    handleRequest(JSON.parse(line))
  } catch {
    process.exitCode = 1
  }
})

if (mode === 'stubborn') {
  // 无视 stdin EOF，赖着不退——close(grace) 必须靠强杀收场。
  input.on('close', () => {})
  setInterval(() => {}, 1_000)
}
