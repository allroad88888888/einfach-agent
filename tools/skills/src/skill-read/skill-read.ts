// tools/skill-read/skill-read.ts —— 读取已选中的仓库 skill 完整正文，或其单个 L3 资源
// （TOOLS-SPEC §9/§10；L3 资源见 docs/skills-tree-blueprint.md 阶段 1）。
// runtime 'internal'：纯只读查询，无副作用。绝不 import state/store/atom；只依赖 skills registry 的只读查询。
import type { Tool } from '@web-agent/core/tools/types'
import guide from './skill-read.md?raw' // skill 正文（同目录 .md）
import { readSkill, readSkillResource, searchSkills } from '../registry'
import { splitFrontmatter } from '@web-agent/core/skills'

const inputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    resource: { type: 'string' },
  },
  required: ['name'],
  additionalProperties: false,
}

// 防御式把未知 args 视为普通对象（非对象 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 项目 skill 的正文与单个资源共用的读取上限，与内置 L3 资源的 64KB 对齐。 */
const PROJECT_READ_MAX_BYTES = 65536

/**
 * 解包 ctx.readWorkspaceFile 的返回值。
 *
 * ★ 它返回的是 `{ok, data}` 结构，不是裸的文件结果 ★ —— 直接取 `.content` 会恒得
 * undefined，于是「读到了空 skill」被当成成功返回给模型（ok:true + 空正文），排查时看不出
 * 任何异常。这里显式判 ok，失败原样透出桥的 error。
 */
function unwrapWorkspaceRead(result: unknown): { ok: true; content: string; truncated: boolean } | { ok: false; error: string } {
  if (!result || typeof result !== 'object') return { ok: false, error: 'workspace read returned an invalid response' }
  const record = result as { ok?: unknown; error?: unknown; data?: unknown }
  if (record.ok !== true) {
    return { ok: false, error: typeof record.error === 'string' ? record.error : 'workspace read failed' }
  }
  const data = (record.data ?? {}) as { content?: unknown; truncated?: unknown }
  return {
    ok: true,
    content: typeof data.content === 'string' ? data.content : '',
    truncated: data.truncated === true,
  }
}

export const skillReadTool: Tool = {
  name: 'skill_read',
  execution: { mode: 'parallel', effectKeys: ['skills:read'] },
  runtime: 'internal',
  skill: {
    description: '读取已选中的仓库 skill 的完整正文；带 resource 参数时改读该 skill 的单个 L3 资源。',
    triggers: ['skill', '技能', '读取 skill', 'skill read'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    // §10 防御式取参：非法/缺失 name 收敛成空字符串，不崩；resource 非字符串时视为省略（读正文）。
    const record = asRecord(args)
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const resource = typeof record.resource === 'string' ? record.resource.trim() : undefined
    if (!name) {
      return {
        ok: false,
        error: 'skill_read requires a non-empty skill name',
        code: 'SKILL_NAME_INVALID',
        retryable: false,
      }
    }
    if (resource !== undefined && !resource) {
      return {
        ok: false,
        error: 'skill_read resource must be non-empty when provided',
        code: 'SKILL_RESOURCE_INVALID',
        retryable: false,
      }
    }

    // --- project/ 前缀：正文与资源都在 workspace 文件系统里，按需读（L2/L3 不进 prompt）---
    if (name.startsWith('project/')) {
      const entry = ctx.skills?.resolveProjectPath(name)
      if (!entry) {
        const available = ctx.skills?.list().filter((skill) => skill.name.startsWith('project/')).map((skill) => skill.name) ?? []
        return {
          ok: false,
          error: `project skill not found: ${name}`,
          code: 'SKILL_NOT_FOUND',
          retryable: false,
          hint: available.length > 0
            ? `Available project skills: ${available.join(', ')}`
            : 'No project skills loaded for this workspace.',
          details: { availableProjectSkills: available },
        }
      }
      if (!ctx.readWorkspaceFile) {
        return {
          ok: false,
          error: 'project skills require workspace file access, which is unavailable in this environment',
          code: 'NOT_AVAILABLE',
          retryable: false,
        }
      }

      // 资源键只认扫描期已发现的那些：路径从快照取，模型给的字符串永远不参与拼路径。
      let targetPath = entry.filePath
      if (resource !== undefined) {
        const resourcePath = entry.resources[resource]
        if (!resourcePath) {
          // 与内置分支同口径：skill 存在、只是资源名错时要说清楚，并列出可读的键。
          const availableResources = Object.keys(entry.resources)
          return {
            ok: false,
            error: `resource not found: ${resource} (skill: ${name}); available resources: `
              + `${availableResources.length > 0 ? availableResources.join(', ') : '(none)'}`,
            code: 'SKILL_RESOURCE_NOT_FOUND',
            retryable: false,
            details: { availableResources },
          }
        }
        targetPath = resourcePath
      }

      let raw: unknown
      try {
        raw = await ctx.readWorkspaceFile({ path: targetPath, maxBytes: PROJECT_READ_MAX_BYTES })
      } catch (err) {
        return {
          ok: false,
          error: `failed to read project skill file: ${err instanceof Error ? err.message : String(err)}`,
          code: 'READ_FAILED',
          retryable: true,
        }
      }
      const read = unwrapWorkspaceRead(raw)
      if (!read.ok) {
        return { ok: false, error: read.error, code: 'READ_FAILED', retryable: true }
      }

      if (resource !== undefined) {
        return {
          ok: true,
          data: { name, resource, content: read.content, truncated: read.truncated },
        }
      }

      // 正文：剥掉 frontmatter（那份元数据已经在 L1 清单里，重复进上下文没有意义）。
      const resources = Object.keys(entry.resources)
      return {
        ok: true,
        data: {
          name,
          skill: {
            name,
            // description 已在清单（L1）里给过，正文响应不再重复；triggers 对项目 skill 只用于检索。
            description: '',
            triggers: [],
            content: splitFrontmatter(read.content).body,
            resources,
          },
          resources,
          truncated: read.truncated,
        },
      }
    }

    // --- 内置 skill（同步路径，保持不变）---
    if (resource !== undefined) {
      const result = readSkillResource(name, resource)
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          code: result.availableResources ? 'SKILL_RESOURCE_NOT_FOUND' : 'SKILL_NOT_FOUND',
          retryable: false,
          details: result.availableResources
            ? { availableResources: result.availableResources }
            : undefined,
        }
      }
      return {
        ok: true,
        data: {
          name: result.name,
          resource: result.resourcePath,
          content: result.content,
          truncated: result.truncated,
        },
      }
    }

    const skill = readSkill(name)
    if (skill) return { ok: true, data: { name, skill, resources: skill.resources } }

    const suggestions = searchSkills(name).slice(0, 3).map((match) => match.name)
    return {
      ok: false,
      error: `skill not found: ${name}`,
      code: 'SKILL_NOT_FOUND',
      retryable: false,
      hint: suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}?`
        : 'Call skill_search with an empty query to list available skills.',
      details: { suggestions },
    }
  },
}
