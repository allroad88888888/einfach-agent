const readline = require('node:readline')

const mode = process.argv[2]
const maxTools = Number(process.argv[3] ?? '1000')

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
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
  if (mode === 'functional') {
    return {
      protocolVersion: '2025-11-25',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fake-server', version: '1.0.0' },
      instructions: 'test server',
    }
  }
  return {
    protocolVersion: '2025-11-25',
    capabilities: { tools: {} },
    serverInfo: { name: `${mode}-server`, version: '1.0.0' },
  }
}

function toolLimitPage(cursor) {
  if (cursor === 'overflow') {
    return { tools: [{ name: 'one-too-many', inputSchema: { type: 'object' } }] }
  }
  return {
    tools: Array.from({ length: maxTools }, (_, index) => ({
      name: `tool-${index}`,
      inputSchema: { type: 'object' },
    })),
    nextCursor: 'overflow',
  }
}

function handleRequest(request) {
  if (request.method === 'initialize') {
    if (mode === 'functional') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', data: 'startup' },
      })}\n`)
    }
    respond(request.id, initializeResult())
    if (mode === 'functional') {
      process.stderr.write('server diagnostic\n')
    }
    if (mode === 'stubborn') {
      input.close()
      setInterval(() => {}, 1_000)
    }
    return
  }

  if (mode === 'exiting' && request.method === 'notifications/initialized') {
    process.exit(7)
  }

  if (mode === 'functional' && request.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' })}\n`)
    respond(request.id, request.params?.cursor === 'next'
      ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
      : {
          tools: [{ name: 'first', description: 'first page', inputSchema: { type: 'object' } }],
          nextCursor: 'next',
        })
    return
  }

  if (mode === 'functional' && request.method === 'tools/call') {
    respond(request.id, {
      content: [{ type: 'text', text: 'called' }],
      structuredContent: { ok: true },
      isError: false,
    })
    return
  }

  if (mode === 'tool-limit' && request.method === 'tools/list') {
    respond(request.id, toolLimitPage(request.params?.cursor))
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  try {
    handleRequest(JSON.parse(line))
  } catch {
    process.exitCode = 1
  }
})
