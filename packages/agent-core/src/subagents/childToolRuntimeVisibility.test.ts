import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '../tools/types'
import { createToolRegistry } from '../tools/toolRegistry'
import { createDelegateAgentRuntime } from './runtime'
import type { DelegateAgentCallContext } from './types'

const VERIFICATION_TOOL = 'run_verification_command'

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function toolCall(id: string, name: string, args: Record<string, unknown>): Response {
  return response({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  })
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function isChildRequest(body: Record<string, unknown>): boolean {
  const first = (body.messages as Array<{ content?: unknown }>)[0]
  return typeof first?.content === 'string' && first.content.includes('树形子 agent')
}

function toolNames(body: Record<string, unknown>): string[] {
  return (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
}

function toolResult(body: Record<string, unknown>, callId: string): Record<string, unknown> {
  const messages = body.messages as Array<{ tool_call_id?: string; content?: string }>
  return JSON.parse(messages.find((message) => message.tool_call_id === callId)?.content ?? '{}')
}

function fixtureTool(name: string, runtime: Tool['runtime']): Tool {
  return {
    name,
    runtime,
    skill: { description: name, content: `${name} guide` },
    inputSchema: { type: 'object', additionalProperties: false },
    execute: () => ({ ok: true, data: { name } }),
  }
}

function context(runChildTool?: DelegateAgentCallContext['runChildTool']): DelegateAgentCallContext {
  const writes = new Map<string, string>()
  return {
    parentPath: 'root',
    parentTranscript: 'root transcript',
    progress() {},
    runChildTool,
    async writeTextFile(input) {
      writes.set(input.path, input.mode === 'append'
        ? `${writes.get(input.path) ?? ''}${input.content}`
        : input.content)
      return { ok: true }
    },
  }
}

function createRuntime(runtimeIsTauri: boolean, fetchImpl: typeof fetch) {
  const registry = createToolRegistry()
  registry.register(fixtureTool('delegate_agent', 'internal'))
  registry.register(fixtureTool('read_file', 'server'))
  registry.register(fixtureTool(VERIFICATION_TOOL, 'server'))
  return createDelegateAgentRuntime({
    sessionId: 'session',
    runId: `run-${Math.random()}`,
    settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    apiKey: 'test-key',
    signal: new AbortController().signal,
    fetchImpl,
    registry,
    // Browser child runtimes must never make server-backed schemas visible to their model loop.
    runtimeIsTauri,
  })
}

async function runVerificationChild(
  runtimeIsTauri: boolean,
  onChildRequest: (body: Record<string, unknown>, turn: number) => Response,
  runChildTool?: DelegateAgentCallContext['runChildTool'],
): Promise<void> {
  let childTurn = 0
  const delegateRuntime = createRuntime(runtimeIsTauri, async (_url, init) => {
    const body = requestBody(init)
    if (!isChildRequest(body)) return response({ role: 'assistant', content: '# distilled skill' })
    childTurn += 1
    return onChildRequest(body, childTurn)
  })
  await delegateRuntime.delegateAgents({
    toolProfile: 'workspace_verify',
    children: [{ objective: 'verify a bounded workspace claim', maxTurns: 4 }],
  }, context(runChildTool))
  await delegateRuntime.dispose?.()
}

describe('child agent server-tool visibility by runtime', () => {
  it('fails closed in Web before a child model sees workspace_verify tools', async () => {
    await runVerificationChild(false, (body) => {
      expect(toolNames(body)).not.toContain('read_file')
      expect(toolNames(body)).not.toContain(VERIFICATION_TOOL)
      return response({ role: 'assistant', content: 'done' })
    })
  })

  it('denies Web schema probes and guessed server-tool calls without invoking the host bridge', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { shouldNotRun: true } }))
    let manifestResult: Record<string, unknown> | undefined
    let schemaResult: Record<string, unknown> | undefined
    let executeResult: Record<string, unknown> | undefined

    await runVerificationChild(false, (body, turn) => {
      if (turn === 1) return toolCall('manifest', 'request_tool_schema', { reason: 'discover tools' })
      if (turn === 2) {
        manifestResult = toolResult(body, 'manifest')
        return toolCall('schema', 'request_tool_schema', { toolName: VERIFICATION_TOOL })
      }
      if (turn === 3) {
        schemaResult = toolResult(body, 'schema')
        return toolCall('guessed', VERIFICATION_TOOL, {})
      }
      executeResult = toolResult(body, 'guessed')
      return response({ role: 'assistant', content: 'done' })
    }, runChildTool)

    expect(manifestResult).toMatchObject({ kind: 'tool_manifest_page' })
    expect((manifestResult?.items as Array<{ name: string }>).map((item) => item.name))
      .not.toEqual(expect.arrayContaining(['read_file', VERIFICATION_TOOL]))
    expect(schemaResult).toEqual({ error: `tool not allowed for child agent: ${VERIFICATION_TOOL}` })
    expect(executeResult).toEqual({ error: `tool not allowed for child agent: ${VERIFICATION_TOOL}` })
    expect(runChildTool).not.toHaveBeenCalled()
  })

  it('permits workspace_verify tools only in the Tauri child runtime', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { verified: true } }))
    let firstTurnTools: string[] = []

    await runVerificationChild(true, (body, turn) => {
      if (turn === 1) {
        firstTurnTools = toolNames(body)
        return toolCall('verify', VERIFICATION_TOOL, {})
      }
      expect(toolResult(body, 'verify')).toEqual({ verified: true })
      return response({ role: 'assistant', content: 'done' })
    }, runChildTool)

    expect(firstTurnTools).toContain('read_file')
    expect(firstTurnTools).toContain(VERIFICATION_TOOL)
    expect(runChildTool).toHaveBeenCalledWith(VERIFICATION_TOOL, {}, expect.any(Number))
  })
})
