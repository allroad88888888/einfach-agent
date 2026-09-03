import { describe, expect, it } from 'vitest'
import { decodeWorkspaceChangeContext } from './decodeWorkspaceChangeContext'

describe('decodeWorkspaceChangeContext', () => {
  it('decodes the four camelCase fields', () => {
    expect(
      decodeWorkspaceChangeContext('write_workspace_file', {
        changeId: 'change',
        sessionId: 'session',
        runId: 'run',
        toolCallId: 'call',
      }),
    ).toEqual({
      changeId: 'change',
      sessionId: 'session',
      runId: 'run',
      toolCallId: 'call',
    })
  })

  it.each([undefined, null])('treats %s as an absent optional context', (value) => {
    expect(decodeWorkspaceChangeContext('delete_workspace_path', value)).toBeUndefined()
  })

  it.each(['change', 1, true, [], () => undefined])(
    'rejects a non-object context (%s) with the command name',
    (value) => {
      expect(() => decodeWorkspaceChangeContext('apply_workspace_patch', value)).toThrow(
        'apply_workspace_patch 的 change_context 必须是对象',
      )
    },
  )

  it.each(['changeId', 'sessionId', 'runId', 'toolCallId'] as const)(
    'requires the camelCase %s field',
    (field) => {
      const value: Record<string, unknown> = {
        changeId: 'change',
        sessionId: 'session',
        runId: 'run',
        toolCallId: 'call',
      }
      delete value[field]

      expect(() => decodeWorkspaceChangeContext('move_workspace_path', value)).toThrow(
        `move_workspace_path 的 change_context.${field} 必须是字符串`,
      )
    },
  )

  it('does not accept snake_case inner fields', () => {
    expect(() =>
      decodeWorkspaceChangeContext('copy_workspace_path', {
        change_id: 'change',
        session_id: 'session',
        run_id: 'run',
        tool_call_id: 'call',
      }),
    ).toThrow('copy_workspace_path 的 change_context.changeId 必须是字符串')
  })
})
