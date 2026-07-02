// agentNew · tool registry（移植自旧 src/agent/tools/registry.ts，裁剪版）。
//
// 设计契约（FEATURES-PLAN §1）：
// - TK2 内置 tool 裁剪：只保留 skill_search / skill_read / ask_user_question /
//   browser_action / save_file 五个；**不建 delegate_agent**（依赖多 agent/worker
//   /architect，整套超本轮范围）。
// - TK3 manifest-only + lazy schema：model 只看 `listToolSummaries()`
//   （name/description/runtime），**摘要里绝不带 inputSchema**；完整 JSON Schema
//   经 `loadTool()` 懒加载合成。禁止预加载。
//
// 本文件零依赖：类型就地定义并 export，不 import runtime/state/UI，保持独立。

/** tool 的执行位置：内置逻辑 / 浏览器侧 / 服务端。 */
export type ToolRuntime = 'internal' | 'browser' | 'server'

/** manifest-only 摘要——model 只看得到这一层（name/description/runtime）。 */
export interface ToolSummary {
  name: string
  description: string
  runtime: ToolRuntime
}

/** 懒加载后的完整 tool——在摘要之上补出 JSON Schema。 */
export interface LoadedTool extends ToolSummary {
  inputSchema: Record<string, unknown>
}

// manifest：只放 name/description/runtime，不含任何 schema（TK3）。
// description/runtime 照抄旧 registry 对应项；delegate_agent 已裁剪（TK2）。
const toolSummaries: ToolSummary[] = [
  {
    name: 'ask_user_question',
    description: '暂停当前 run，向用户提出一个或多个结构化问题并收集缺失决策。',
    runtime: 'internal',
  },
  {
    name: 'skill_search',
    description: '按名称、描述或触发词搜索仓库 skills。',
    runtime: 'internal',
  },
  {
    name: 'skill_read',
    description: '读取已选中的仓库 skill 内容。',
    runtime: 'internal',
  },
  {
    name: 'browser_action',
    description: '渲染信息卡片到对话流（render_card）。',
    runtime: 'browser',
  },
  {
    name: 'save_file',
    description: '准备一份文件内容供用户在浏览器内手势保存到本地（File System Access）。',
    runtime: 'browser',
  },
]

// lazy schema：完整 inputSchema 只在 loadTool 时才取用，不进 manifest（TK3）。
const toolSchemas: Record<string, Record<string, unknown>> = {
  ask_user_question: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'text', 'type'],
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            type: { enum: ['text', 'single-choice', 'multi-choice', 'confirm'] },
            options: { type: 'array', items: { type: 'string' } },
            required: { type: 'boolean' },
          },
        },
      },
    },
    required: ['id', 'questions'],
  },
  skill_search: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  skill_read: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  },
  browser_action: {
    type: 'object',
    properties: {
      action: { enum: ['render_card'] },
      payload: {
        type: 'object',
        // 执行侧 BrowserCard 只承载 title/body；schema 不再广告 items/options，
        // 避免误导 model 传无效字段（契约一致性）。
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title'],
      },
    },
    required: ['action', 'payload'],
  },
  save_file: {
    type: 'object',
    properties: {
      filename: { type: 'string' },
      content: { type: 'string' },
      mimeType: { type: 'string' },
    },
    required: ['filename', 'content'],
  },
}

/** manifest-only 列表：给 model 看的只有这一层，永不含 inputSchema（TK3）。 */
export function listToolSummaries(): ToolSummary[] {
  return toolSummaries
}

/** name/description/runtime 子串匹配（大小写不敏感）。 */
export function searchTools(query: string): ToolSummary[] {
  const normalizedQuery = query.toLowerCase()
  return toolSummaries.filter((tool) => {
    const searchable = [tool.name, tool.description, tool.runtime].join(' ').toLowerCase()
    return searchable.includes(normalizedQuery)
  })
}

/** 懒加载：摘要 + toolSchemas[name] 合成完整 LoadedTool；未知名字返回 undefined。 */
export function loadTool(name: string): LoadedTool | undefined {
  const summary = toolSummaries.find((tool) => tool.name === name)
  if (!summary) return undefined

  return {
    ...summary,
    inputSchema: toolSchemas[name] ?? {},
  }
}
