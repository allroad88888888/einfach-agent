import { describe, expect, it, vi } from 'vitest'
import type { ModelFunctionTool } from '@web-agent/ai'
import type { LoadedTool } from '../tools/types'
import { selectToolGate } from './toolGates'

function tool(name: string): ModelFunctionTool {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object' } },
  }
}

function loadedTool(name: string): LoadedTool {
  return {
    name,
    description: name,
    runtime: 'internal',
    inputSchema: { type: 'object' },
    guide: `guide for ${name}`,
    registrationVersion: 7,
  }
}

function input(overrides: Partial<Parameters<typeof selectToolGate>[0]> = {}) {
  return {
    name: 'read_file',
    args: {},
    turnTools: [tool('read_file')],
    isSynthesisTurn: false,
    isAllowedTool: (name: string) => name === 'delegate_agent' || name === 'read_file',
    loadSchema: vi.fn(() => undefined),
    expectedRegistrationVersion: 7,
    registrationVersion: vi.fn(() => 7),
    canExecuteTool: (name: string) => name === 'read_file',
    delegate: { name: 'delegate_agent', path: 'root-01', depth: 1, maxDepth: 3 },
    ...overrides,
  }
}

describe('selectToolGate', () => {
  it('routes schema discovery and rejects an out-of-profile schema request', () => {
    expect(selectToolGate(input({
      name: 'request_tool_schema',
      args: { query: 'read' },
    }))).toEqual({ kind: 'schema_request', toolName: '' })

    expect(selectToolGate(input({
      name: 'request_tool_schema',
      args: { toolName: 'write_file' },
    }))).toEqual({
      kind: 'schema_request_denied',
      toolName: 'write_file',
      result: { error: 'tool not allowed for child agent: write_file' },
    })
  })

  it('autoloads an allowed tool missing from this turn without executing it', () => {
    const schema = loadedTool('read_file')
    const loadSchema = vi.fn(() => schema)

    expect(selectToolGate(input({ turnTools: [], loadSchema }))).toMatchObject({
      kind: 'schema_autoloaded',
      tool: schema,
      result: { loaded: true, toolName: 'read_file', executed: false },
    })
    expect(loadSchema).toHaveBeenCalledWith('read_file')
  })

  it('does not autoload from a synthesis turn or for an already exposed tool', () => {
    const loadSchema = vi.fn(() => loadedTool('read_file'))

    expect(selectToolGate(input({ isSynthesisTurn: true, turnTools: [], loadSchema }))).toEqual({
      kind: 'execute',
    })
    expect(selectToolGate(input({ loadSchema }))).toEqual({ kind: 'execute' })
    expect(loadSchema).not.toHaveBeenCalled()
  })

  it('rejects allowed calls whose registration snapshot is missing or stale', () => {
    expect(selectToolGate(input({ expectedRegistrationVersion: undefined }))).toMatchObject({
      kind: 'registration_changed',
      result: { code: 'tool_registration_changed', expectedRegistrationVersion: undefined },
    })
    expect(selectToolGate(input({
      expectedRegistrationVersion: 6,
      registrationVersion: () => 7,
    }))).toMatchObject({
      kind: 'registration_changed',
      result: { expectedRegistrationVersion: 6, currentRegistrationVersion: 7 },
    })
  })

  it('guards delegation depth before returning the delegation action', () => {
    expect(selectToolGate(input({
      name: 'delegate_agent',
      turnTools: [tool('delegate_agent')],
    }))).toEqual({ kind: 'delegate' })

    expect(selectToolGate(input({
      name: 'delegate_agent',
      turnTools: [tool('delegate_agent')],
      delegate: { name: 'delegate_agent', path: 'root-01', depth: 3, maxDepth: 3 },
    }))).toEqual({
      kind: 'delegate_depth_reached',
      result: { error: 'max subagent depth reached at root-01' },
    })
  })

  it('permits only allowed executable tools and rejects every remaining call', () => {
    expect(selectToolGate(input())).toEqual({ kind: 'execute' })
    expect(selectToolGate(input({
      name: 'write_file',
      turnTools: [tool('write_file')],
      canExecuteTool: () => true,
    }))).toEqual({
      kind: 'tool_not_allowed',
      result: { error: 'tool not allowed for child agent: write_file' },
    })
  })
})
