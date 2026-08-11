import { describe, expect, it } from 'vitest'
import {
  attachMcpFailureKind,
  classifyMcpFailure,
  readMcpFailureKind,
} from './failureClassification'

function withCode(message: string, code: number): Error {
  const error = new Error(message)
  ;(error as unknown as { code: number }).code = code
  return error
}

/** Mirrors what tauriStdioConnector.ts builds out of a Rust McpCommandError. */
function withKind(kind: string, message: string): Error {
  return attachMcpFailureKind(new Error(message), kind)
}

describe('classifyMcpFailure', () => {
  it('classifies HTTP 401/403 as a permanent auth failure', () => {
    expect(classifyMcpFailure(withCode('Streamable HTTP error: nope', 401))).toMatchObject({
      status: 'error',
      reason: 'auth',
    })
    expect(classifyMcpFailure(withCode('Streamable HTTP error: nope', 403))).toMatchObject({
      status: 'error',
      reason: 'auth',
    })
  })

  it('classifies an "Unauthorized"-shaped message as a permanent auth failure even without a status code', () => {
    expect(classifyMcpFailure(new Error('Unauthorized'))).toMatchObject({
      status: 'error',
      reason: 'auth',
    })
    expect(classifyMcpFailure(new Error('authentication failed: invalid api key'))).toMatchObject(
      { status: 'error', reason: 'auth' },
    )
  })

  it('classifies other 4xx (excluding 408/429) as permanent config_invalid', () => {
    expect(classifyMcpFailure(withCode('Error POSTing to endpoint: bad request', 400))).toMatchObject({
      status: 'error',
      reason: 'config_invalid',
    })
    expect(classifyMcpFailure(withCode('not found', 404))).toMatchObject({
      status: 'error',
      reason: 'config_invalid',
    })
  })

  it('classifies rate-limit and request-timeout HTTP codes as temporary', () => {
    expect(classifyMcpFailure(withCode('slow down', 429))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
    expect(classifyMcpFailure(withCode('timed out', 408))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
  })

  it('classifies 5xx server errors as temporary', () => {
    expect(classifyMcpFailure(withCode('internal error', 500))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
  })

  it('classifies empty id/command/URL config errors as permanent config_invalid', () => {
    expect(classifyMcpFailure(new Error('MCP server id must not be empty'))).toMatchObject({
      status: 'error',
      reason: 'config_invalid',
    })
    expect(classifyMcpFailure(new Error('MCP stdio command must not be empty'))).toMatchObject({
      status: 'error',
      reason: 'config_invalid',
    })
    expect(
      classifyMcpFailure(new Error('MCP Streamable HTTP URL must use http or https: ftp://x')),
    ).toMatchObject({ status: 'error', reason: 'config_invalid' })
  })

  it('classifies the desktop stdio spawn kind as permanent command_unavailable', () => {
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

  it('lets unknown and transport kinds fall through to the existing rules', () => {
    // A kind the Rust side adds later must not reclassify anything by itself.
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

  it('classifies tool-count and tool-name-collision errors as permanent', () => {
    expect(
      classifyMcpFailure(new Error('MCP server "srv" exceeded 1000 tools')),
    ).toMatchObject({ status: 'error', reason: 'tool_limit_exceeded' })
    expect(
      classifyMcpFailure(new Error('MCP tools/list exceeded 1000 tools')),
    ).toMatchObject({ status: 'error', reason: 'tool_limit_exceeded' })
    expect(
      classifyMcpFailure(new Error('MCP server "srv" returned colliding tool names for "x"')),
    ).toMatchObject({ status: 'error', reason: 'tool_name_collision' })
    expect(
      classifyMcpFailure(new Error('MCP tool name conflicts with an existing tool: x')),
    ).toMatchObject({ status: 'error', reason: 'tool_name_collision' })
  })

  it('classifies an unsupported taskSupport declaration as permanent', () => {
    expect(
      classifyMcpFailure(
        new Error('MCP tool "job" requires task-based execution, but this client does not support MCP Tasks'),
      ),
    ).toMatchObject({ status: 'error', reason: 'unsupported_capability' })
  })

  it('classifies malformed/oversized protocol responses as permanent protocol_violation', () => {
    expect(
      classifyMcpFailure(new Error('MCP server "srv" returned an invalid tool list')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP server "srv" returned a tool with an empty name')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP tools/list exceeded 100 pages')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP tools/list repeated cursor: abc')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP tool "x" has a non-object input schema')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP Streamable HTTP response exceeded 4194304 bytes')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP input schema exceeds the 128000-character safety limit')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
    expect(
      classifyMcpFailure(new Error('MCP tool result contains a cyclic or repeated object reference')),
    ).toMatchObject({ status: 'error', reason: 'protocol_violation' })
  })

  it('defaults unclassified failures to temporary connection_disrupted', () => {
    expect(classifyMcpFailure(new Error('transport lost'))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
    expect(classifyMcpFailure(new Error('fetch failed'))).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
    expect(classifyMcpFailure('a plain string reason')).toMatchObject({
      status: 'reconnecting',
      reason: 'connection_disrupted',
    })
  })

  it('always embeds the original detail message in the user-facing text', () => {
    const classification = classifyMcpFailure(new Error('socket hang up'))
    expect(classification.message).toContain('socket hang up')
    expect(classification.message).toContain('可以重试')
  })
})
