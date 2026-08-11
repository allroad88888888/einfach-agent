// One contract, pinned from every angle: **classifyMcpFailure must never derive
// a permanent verdict from text written outside this package.** Foreign text
// arrives from three places — the desktop Rust bridge (D5), the remote MCP
// server relayed through it or through the SDK, and HTTP response bodies (D6) —
// and each one gets reworded, localized, or chosen by someone who is not us.
//
// The decision table for the signals we *do* own lives in
// failureClassification.test.ts.
import { describe, expect, it } from 'vitest'
import {
  attachMcpFailureKind,
  classifyMcpFailure,
  readMcpFailureKind,
} from './failureClassification'

/** Mirrors what tauriStdioConnector.ts builds out of a Rust McpCommandError. */
function withKind(kind: string, message: string): Error {
  return attachMcpFailureKind(new Error(message), kind)
}

/** Mirrors the SDK's StreamableHTTPError, whose `code` is the response status. */
function withHttpStatus(message: string, code: number): Error {
  const error = new Error(message)
  ;(error as unknown as { code: number }).code = code
  return error
}

/**
 * Mirrors the SDK's McpError: `name` is 'McpError', `code` is the *remote's*
 * JSON-RPC error code, and the message wraps the remote's own error text.
 */
function asMcpError(message: string, code: number): Error {
  const error = new Error(message)
  error.name = 'McpError'
  ;(error as unknown as { code: number }).code = code
  return error
}

describe('classifyMcpFailure / desktop bridge kinds', () => {
  it('classifies the stdio spawn kind as permanent command_unavailable', () => {
    expect(
      classifyMcpFailure(
        withKind(
          'command_spawn_failed',
          'failed to start MCP server `local-files`: No such file or directory (os error 2)',
        ),
      ),
    ).toMatchObject({ status: 'error', reason: 'command_unavailable' })
  })

  // This is the D5 guarantee: the stdio verdict is a function of the structured
  // kind ONLY. Every message below — including one that would otherwise be read
  // as a temporary failure, one that would be read as a *different* permanent
  // failure, and an empty one — must yield the exact same classification, so
  // rewording (or localizing) apps/desktop/src/mcp.rs cannot silently downgrade
  // a permanent failure into an infinite reconnect loop.
  it('classifies a stdio spawn failure from the kind alone, whatever the Rust message says', () => {
    const rewrittenRustMessages = [
      'failed to start MCP server `local-files`: No such file or directory (os error 2)',
      '无法启动 MCP 服务器 `local-files`：系统找不到指定的文件',
      'transport lost',
      'MCP server "srv" returned an invalid tool list',
      '',
    ]

    const classifications = rewrittenRustMessages.map((message) =>
      classifyMcpFailure(withKind('command_spawn_failed', message)),
    )

    for (const classification of classifications) {
      expect(classification).toMatchObject({
        status: 'error',
        reason: 'command_unavailable',
      })
    }
    expect(new Set(classifications.map((entry) => entry.status)).size).toBe(1)
    expect(new Set(classifications.map((entry) => entry.reason)).size).toBe(1)
  })

  it('no longer infers a stdio spawn failure from message text without a kind', () => {
    // The undeclared prose contract with apps/desktop/src/mcp.rs is gone on
    // purpose: an error that never carried a kind is not a bridge spawn failure.
    expect(
      classifyMcpFailure(
        new Error('failed to start MCP server `local-files`: No such file or directory (os error 2)'),
      ),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
    expect(classifyMcpFailure(new Error('spawn mcp-server ENOENT'))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
  })

  it('keeps post-spawn host setup failures (spawn_failed) temporary', () => {
    // The child already started; failing to attach its pipes or reader threads
    // is a host resource problem, not a broken command.
    expect(
      classifyMcpFailure(withKind('spawn_failed', 'failed to capture MCP server stdin')),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
    expect(
      classifyMcpFailure(withKind('spawn_failed', 'failed to start MCP protocol reader: EAGAIN')),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
  })

  it('classifies the protocol_error kind from the kind alone', () => {
    // Its Rust message inlines the server's own cursor and protocolVersion, so
    // the verdict has to be structural — the third message below would otherwise
    // let the server hand itself a config_invalid reason via /must not be empty/.
    const messages = [
      'invalid tools/list result: missing field `name`',
      'tools/list returned the repeated cursor `abc`',
      'MCP server selected unsupported protocolVersion `must not be empty`',
      'initialize result capabilities must be an object',
      '',
    ]

    for (const message of messages) {
      expect(classifyMcpFailure(withKind('protocol_error', message))).toMatchObject({
        status: 'error',
        reason: 'protocol_violation',
      })
    }
  })

  it('lets unknown and transport kinds fall through to the existing rules', () => {
    // A kind the Rust side adds later must not reclassify anything by itself,
    // and host-authored bridge messages stay matchable.
    expect(
      classifyMcpFailure(withKind('a_kind_added_later', 'MCP server id must not be empty')),
    ).toMatchObject({ status: 'error', reason: 'config_invalid' })
    expect(
      classifyMcpFailure(withKind('transport_closed', 'MCP server transport is closed')),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
  })

  it('carries the kind as a non-enumerable field so it never leaks into logs', () => {
    const error = withKind('command_spawn_failed', 'boom')
    expect(readMcpFailureKind(error)).toBe('command_spawn_failed')
    expect(Object.keys(error)).not.toContain('mcpFailureKind')
    expect(JSON.stringify({ ...error })).not.toContain('command_spawn_failed')
    expect(readMcpFailureKind(new Error('boom'))).toBeUndefined()
    expect(readMcpFailureKind('not an error')).toBeUndefined()
  })
})

describe('classifyMcpFailure / text the remote server controls', () => {
  it('never lets a remote JSON-RPC error message reach the permanent message rules', () => {
    // apps/desktop/src/mcp.rs formats rpc_error as
    // "MCP request `m` failed: {server error.message} ({code})", so everything
    // after the colon is the server's. A healthy server answering any of these
    // used to be declared permanently broken and never retried again.
    const remoteWordings = [
      'workspace must not be empty',
      'exceeded 5 tools',
      'returned an invalid tool list',
      'repeated cursor detected upstream',
      'the file has a non-object input schema',
      'this job requires task-based execution',
    ]

    for (const wording of remoteWordings) {
      expect(
        classifyMcpFailure(
          withKind('rpc_error', `MCP request \`tools/call\` failed: ${wording} (-32000)`),
        ),
      ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
    }
  })

  it('does not let an SDK McpError message reach the permanent message rules', () => {
    expect(
      classifyMcpFailure(asMcpError('MCP error -32603: exceeded 9 tools', -32603)),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
    expect(
      classifyMcpFailure(asMcpError('MCP error -32603: id must not be empty', -32603)),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
  })

  it('does not read an HTTP status out of a remote JSON-RPC error code', () => {
    // McpError.code is picked by the server and JSON-RPC reserves nothing in
    // 100–599, so a 403 here must not be promoted to an "HTTP 403" auth verdict.
    expect(classifyMcpFailure(asMcpError('MCP error 403: go away', 403))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
    expect(classifyMcpFailure(asMcpError('MCP error 400: bad', 400))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
    expect(classifyMcpFailure(asMcpError('MCP error 401: nope', 401)).message).not.toContain('HTTP')
  })

  it('decides a coded HTTP failure on the status alone, never on the response body', () => {
    // The SDK inlines the whole response body as "Error POSTing to endpoint:
    // {text}", so the body must stay inert next to a retryable status.
    expect(
      classifyMcpFailure(
        withHttpStatus('Error POSTing to endpoint: MCP tools/list exceeded 1000 tools', 500),
      ),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
    expect(
      classifyMcpFailure(
        withHttpStatus('Error POSTing to endpoint: server returned an invalid tool list', 503),
      ),
    ).toMatchObject({ status: 'reconnecting', reason: 'connection_disrupted' })
    expect(
      classifyMcpFailure(withHttpStatus('Error POSTing to endpoint: invalid api key', 429)),
    ).toMatchObject({ status: 'reconnecting' })
  })

  it('still applies the message rules to failures this package throws itself', () => {
    // The contrast case: no kind, no HTTP status, our own deterministic strings.
    expect(
      classifyMcpFailure(new Error('MCP Streamable HTTP response exceeded 4194304 bytes')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP server "srv" exceeded 1000 tools')),
    ).toMatchObject({ status: 'error', reason: 'tool_limit_exceeded' })
  })
})

describe('classifyMcpFailure / auth with and without a structured signal', () => {
  it('ends retrying only when the transport-observed HTTP status says 401/403', () => {
    for (const status of [401, 403]) {
      const classification = classifyMcpFailure(
        withHttpStatus('Streamable HTTP error: Error POSTing to endpoint: nope', status),
      )
      expect(classification).toMatchObject({ status: 'error', reason: 'auth' })
      expect(classification.message).toContain(`HTTP ${status}`)
    }
  })

  // Without a status all we have is prose owned by third-party servers and by
  // the SDK: localizable, rewordable, and echoable by a server that is not
  // failing on auth at all. It still earns the 'auth' label — that is the most
  // useful thing to show — but it may not end retrying, because the reverse
  // mistake (a wrong key retried) is bounded by the caller's capped backoff
  // while a wrong permanent verdict needs a human to undo.
  it('keeps an "unauthorized"-shaped message retryable while still labelling it auth', () => {
    expect(classifyMcpFailure(new Error('Unauthorized'))).toMatchObject({
      status: 'reconnecting',
      reason: 'auth',
    })
    expect(classifyMcpFailure(new Error('authentication failed: invalid api key'))).toMatchObject({
      status: 'reconnecting',
      reason: 'auth',
    })
    expect(
      classifyMcpFailure(withKind('rpc_error', 'MCP request `initialize` failed: invalid token (-32000)')),
    ).toMatchObject({ status: 'reconnecting', reason: 'auth' })
  })

  it('tells the user to check credentials while it keeps retrying', () => {
    const classification = classifyMcpFailure(new Error('Unauthorized'))
    expect(classification.message).toContain('身份认证失败')
    expect(classification.message).toContain('检查凭证')
  })
})
