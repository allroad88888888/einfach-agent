// contextCache 两个测试文件共享的输入构造(非测试文件,vitest 不收集)。
import type { ModelFunctionTool, ModelItem } from '@web-agent/ai'
import type { ObserveContextCacheInput } from './contextCache'

export function tool(name: string): ModelFunctionTool {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
    },
  }
}

export const system: ModelItem = { role: 'system', content: 'fixed system' }
export const user: ModelItem = { role: 'user', content: 'hello' }
export const skill: ModelItem = { role: 'system', content: 'dynamic skill' }

export function input(overrides: Partial<ObserveContextCacheInput> = {}): ObserveContextCacheInput {
  return {
    lane: 'main',
    scope: 'run-1:root',
    vendor: 'test-vendor',
    model: 'test-model',
    messages: [system, user],
    systemContent: 'fixed system',
    tools: [tool('request_tool_schema'), tool('read_file')],
    toolChoice: 'auto',
    thinking: 'enabled',
    reasoningEffort: 'high',
    compacted: false,
    requestMode: 'tool_loop',
    ...overrides,
  }
}
