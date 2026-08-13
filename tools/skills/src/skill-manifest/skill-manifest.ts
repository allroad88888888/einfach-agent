// tools/skills 的 sessionStart 工具：把已确保加载的内置与项目 skills 组成 L1 清单。
// 清单读取只经 ToolContext 注入的实例槽，避免 tools 包反向依赖 core 的项目 skill loader。
import type { Tool } from '@web-agent/core/tools'
import { buildSkillManifestText } from '../registry'

const inputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

/** 在会话开始时生成模型可读的 L1 skills 清单。 */
export const skillManifestTool: Tool = {
  name: 'skill_manifest',
  execution: { mode: 'serial', effectKeys: ['skills:manifest'] },
  runtime: 'internal',
  callTiming: 'sessionStart',
  skill: {
    description: '在会话开始时生成当前可用 skills 的一级清单。',
    content: '该工具由运行时在会话开始时调用，用于提供当前可用 skills 的一级清单。',
  },
  inputSchema,
  async execute(_args, ctx) {
    const snapshot = await ctx.projectSkills?.ensure()
    return { ok: true, data: buildSkillManifestText(snapshot) }
  },
}
