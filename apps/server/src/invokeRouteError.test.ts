import { NodeHostCommandError } from '@web-agent/host-node'
import { describe, expect, it } from 'vitest'
import { mapNodeHostCommandError } from './invokeRouteError'

describe('mapNodeHostCommandError', () => {
  it('unknown-command 映射到 404', () => {
    const error = new NodeHostCommandError('bogus_command', 'unknown-command')
    const mapped = mapNodeHostCommandError(error)
    expect(mapped.statusCode).toBe(404)
    expect(mapped.error).toBe('unknown_command')
    // 直接复用 host-node 的文案，不重新组一遍——避免两处中文各写一份、后续漂移。
    expect(mapped.message).toBe(error.message)
  })

  it('unimplemented 映射到 501', () => {
    const error = new NodeHostCommandError('mcp_list_tools', 'unimplemented')
    const mapped = mapNodeHostCommandError(error)
    expect(mapped.statusCode).toBe(501)
    expect(mapped.error).toBe('command_not_implemented')
    expect(mapped.message).toBe(error.message)
  })
})
