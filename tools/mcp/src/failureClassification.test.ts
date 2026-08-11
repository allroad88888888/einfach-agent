import { describe, expect, it } from 'vitest'
import { classifyMcpFailure } from './failureClassification'

function withCode(message: string, code: number): Error {
  const error = new Error(message)
  ;(error as unknown as { code: number }).code = code
  return error
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

  it('classifies the desktop stdio spawn-failure text as permanent command_unavailable', () => {
    expect(
      classifyMcpFailure(
        new Error('failed to start MCP server `local-files`: No such file or directory (os error 2)'),
      ),
    ).toMatchObject({ status: 'error', reason: 'command_unavailable' })
  })

  it('classifies common OS-level spawn error text as permanent command_unavailable', () => {
    expect(classifyMcpFailure(new Error('spawn mcp-server ENOENT'))).toMatchObject({
      status: 'error',
      reason: 'command_unavailable',
    })
    expect(
      classifyMcpFailure(new Error("'mcp-server' is not recognized as an internal or external command")),
    ).toMatchObject({ status: 'error', reason: 'command_unavailable' })
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
