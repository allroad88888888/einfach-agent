// One contract, pinned from every angle: **classifyMcpFailure must never derive
// a permanent verdict from text written outside this package.** Foreign text
// arrives from three places — the host bridge, the remote MCP server relayed
// through it or through the SDK, and HTTP response bodies (D6) — and each one
// gets reworded, localized, or chosen by someone who is not us.
//
// The decision table for the signals we *do* own lives in
// failureClassification.test.ts. The bridge's own half of the rule — that its
// verdict is a function of the kind it minted and never of the message — is
// pinned in packages/host-node/src/mcp/failureKinds.test.ts.
import { describe, expect, it } from 'vitest'
import {
  attachMcpFailureVerdict,
  classifyMcpFailure,
  readMcpFailureVerdict,
  type McpFailureVerdict,
} from './failureClassification'

/** Mirrors what serverMcpCommands.ts builds out of the bridge's 502 envelope. */
function withVerdict(verdict: McpFailureVerdict, message: string): Error {
  return attachMcpFailureVerdict(new Error(message), verdict)
}

const PERMANENT_SPAWN: McpFailureVerdict = { retryable: false, reason: 'command_unavailable' }
const RETRYABLE: McpFailureVerdict = { retryable: true, reason: 'connection_disrupted' }

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

describe('classifyMcpFailure / verdicts handed down by the bridge', () => {
  it('takes the bridge\'s permanent verdict and its reason', () => {
    expect(
      classifyMcpFailure(
        withVerdict(
          PERMANENT_SPAWN,
          'failed to start MCP server `local-files`: No such file or directory (os error 2)',
        ),
      ),
    ).toMatchObject({ status: 'error', reason: 'command_unavailable' })
  })

  // This is the D5 guarantee, restated for the shape it has now: the stdio verdict is a function of
  // the *structured* signal ONLY. Every message below — including one that would otherwise be read
  // as a temporary failure, one that would be read as a *different* permanent failure, and an empty
  // one — must yield the exact same classification, so rewording (or localizing) a bridge message
  // cannot silently downgrade a permanent failure into an infinite reconnect loop.
  //
  // The bridge writing those messages is `packages/host-node/src/mcp/` (`childProcess.ts` for this
  // one). The Rust wording in the samples is kept deliberately — the whole point is that the text is
  // irrelevant, so stale sample strings are the strongest form of the same assertion.
  it('classifies a stdio spawn failure from the verdict alone, whatever the message says', () => {
    const rewrittenMessages = [
      'failed to start MCP server `local-files`: No such file or directory (os error 2)',
      '无法启动 MCP 服务器 `local-files`：系统找不到指定的文件',
      'transport lost',
      'MCP server "srv" returned an invalid tool list',
      '',
    ]

    const classifications = rewrittenMessages.map((message) =>
      classifyMcpFailure(withVerdict(PERMANENT_SPAWN, message)),
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

  it('no longer infers a stdio spawn failure from message text without a verdict', () => {
    // The undeclared prose contract with the stdio bridge is gone on purpose: an error that never
    // carried a structured signal is not a bridge spawn failure.
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

  it('a retryable verdict is never overturned by the message beside it', () => {
    // The bridge said "retry may help". Every message here would hit a permanent rule further down
    // if a verdict-carrying error were allowed to reach those rules — and each of them is text this
    // package did not write: host prose in the first two, the remote server's own words (relayed by
    // `session.ts` as "MCP request `m` failed: {server message}") in the last two.
    const messages = [
      'failed to capture MCP server stdio',
      'MCP server transport is closed',
      'MCP request `tools/call` failed: workspace must not be empty (-32000)',
      'MCP request `tools/list` failed: exceeded 5 tools (-32000)',
    ]

    for (const message of messages) {
      expect(classifyMcpFailure(withVerdict(RETRYABLE, message))).toMatchObject({
        status: 'reconnecting',
        reason: 'connection_disrupted',
      })
    }
  })

  // The whole point of moving the table to the bridge: **this file does not enumerate the bridge's
  // failure kinds any more.** A kind added or renamed in `packages/host-node/src/mcp/` arrives here
  // as a verdict, so it is honoured without editing a line of this package — including a reason
  // string this build has never heard of, which keeps the verdict and only loses label precision.
  it('honours a verdict whose reason this build does not know', () => {
    const unknownReason = classifyMcpFailure(
      withVerdict({ retryable: false, reason: 'a_reason_added_later' }, 'MCP server id must not be empty'),
    )

    expect(unknownReason).toMatchObject({ status: 'error', reason: 'a_reason_added_later' })
    expect(unknownReason.message).toContain('需要人工介入才能恢复')
    // …and the same unknown reason on the retryable side stays retryable, even though the message
    // would otherwise match /must not be empty/ and be called permanently broken.
    expect(
      classifyMcpFailure(
        withVerdict({ retryable: true, reason: 'a_reason_added_later' }, 'MCP server id must not be empty'),
      ),
    ).toMatchObject({ status: 'reconnecting', reason: 'a_reason_added_later' })
  })

  it('carries the verdict as a non-enumerable field so it never leaks into logs', () => {
    const error = withVerdict(PERMANENT_SPAWN, 'boom')
    expect(readMcpFailureVerdict(error)).toEqual(PERMANENT_SPAWN)
    expect(Object.keys(error)).not.toContain('mcpFailureVerdict')
    expect(JSON.stringify({ ...error })).not.toContain('command_unavailable')
    expect(readMcpFailureVerdict(new Error('boom'))).toBeUndefined()
    expect(readMcpFailureVerdict('not an error')).toBeUndefined()
  })
})

describe('classifyMcpFailure / text the remote server controls', () => {
  it('never lets a remote JSON-RPC error message reach the permanent message rules', () => {
    // `packages/host-node/src/mcp/session.ts` formats rpc_error as
    // "MCP request `m` failed: {server error.message} ({code})", so everything
    // after the colon is the server's. A healthy server answering any of these
    // used to be declared permanently broken and never retried again.
    // (That format was ported verbatim from `apps/desktop/src/mcp.rs`, deleted
    // with the desktop host in `e52c31d`.)
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
          withVerdict(RETRYABLE, `MCP request \`tools/call\` failed: ${wording} (-32000)`),
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
      classifyMcpFailure(withVerdict(RETRYABLE, 'MCP request `initialize` failed: invalid token (-32000)')),
    ).toMatchObject({ status: 'reconnecting', reason: 'auth' })
  })

  it('tells the user to check credentials while it keeps retrying', () => {
    const classification = classifyMcpFailure(new Error('Unauthorized'))
    expect(classification.message).toContain('身份认证失败')
    expect(classification.message).toContain('检查凭证')
  })
})
