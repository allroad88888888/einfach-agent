import { describe, it, expect } from 'vitest'
import {
  buildSkillManifestText,
  listSkillSummaries,
  searchSkills,
  readSkill,
  readSkillResource,
} from './registry'

describe('skills/registry（agentNew · 移植版）', () => {
  it('readSkill(web-chat-agent) 返回 content 非空', () => {
    const skill = readSkill('web-chat-agent')

    expect(skill).toBeDefined()
    expect(skill?.name).toBe('web-chat-agent')
    expect(typeof skill?.content).toBe('string')
    expect(skill?.content.length).toBeGreaterThan(0)
  })

  it('readSkill 未知名字返回 undefined', () => {
    expect(readSkill('nope')).toBeUndefined()
  })

  it('listSkillSummaries 每项都是 summary-only（无 content 键）', () => {
    const summaries = listSkillSummaries()

    expect(summaries.length).toBeGreaterThan(0)
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('content')
      expect(summary.name).toBeTruthy()
      expect(summary.description).toBeTruthy()
      expect(Array.isArray(summary.triggers)).toBe(true)
    }
  })

  it('searchSkills 按 name/description/triggers 双向子串匹配', () => {
    // query 是触发词的子串（searchable 命中）。
    const byTrigger = searchSkills('echarts').map((skill) => skill.name)
    expect(byTrigger).toContain('data-visualization')

    // query 反向包含触发词（normalizedQuery.includes(trigger)）。
    const byReverse = searchSkills('请帮我提问确认一下').map((skill) => skill.name)
    expect(byReverse).toContain('ask-user-question')
  })

  // --- 阶段 1（docs/skills-tree-blueprint.md）：树形资源与 L3 读取 ---------------------------

  it('readSkill 附带 resources 键列表；planning 试点树形化后含 references/evaluation.md', () => {
    const planning = readSkill('planning')
    expect(planning?.resources).toContain('references/evaluation.md')

    // 未拆分资源的 skill：resources 是空数组，不是 undefined。
    const baseSkill = readSkill('web-chat-agent')
    expect(baseSkill?.resources).toEqual([])
  })

  it('readSkillResource 命中已知资源 → ok:true 带 content 与 truncated:false', () => {
    const result = readSkillResource('planning', 'references/evaluation.md')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok:true')
    expect(result.name).toBe('planning')
    expect(result.resourcePath).toBe('references/evaluation.md')
    expect(result.content.length).toBeGreaterThan(0)
    expect(result.truncated).toBe(false)
  })

  it('readSkillResource 未知资源键 → ok:false，附可用键列表且 error 文案含该列表', () => {
    const result = readSkillResource('planning', 'references/nope.md')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected ok:false')
    expect(result.availableResources).toEqual(['references/evaluation.md'])
    expect(result.error).toContain('references/nope.md')
    expect(result.error).toContain('references/evaluation.md')
  })

  it('readSkillResource 未知 skill → ok:false，error 含 skill 名，不附 availableResources', () => {
    const result = readSkillResource('nope-skill', 'references/x.md')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected ok:false')
    expect(result.error).toContain('nope-skill')
    expect(result.availableResources).toBeUndefined()
  })

  it('readSkillResource 对无资源的 skill 请求任意键 → ok:false，availableResources 为空数组', () => {
    const result = readSkillResource('web-chat-agent', 'references/whatever.md')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected ok:false')
    expect(result.availableResources).toEqual([])
  })

  it('资源键精确匹配，不做路径规范化：前缀/相似但不完全一致的键视为未命中', () => {
    // 真实键是 'references/evaluation.md'；这里故意加前导 './' 与大小写差异，均不应命中。
    expect(readSkillResource('planning', './references/evaluation.md').ok).toBe(false)
    expect(readSkillResource('planning', 'References/Evaluation.md').ok).toBe(false)
  })

  // --- 阶段 3（docs/skills-tree-blueprint.md）：全量清单进稳定前缀 -----------------------------

  it('buildSkillManifestText 列出全部已注册 skill（name + description 各一行）', () => {
    const manifest = buildSkillManifestText()
    const summaries = listSkillSummaries()

    expect(manifest.split('\n')).toHaveLength(summaries.length + 1) // 抬头 1 行 + 每个 skill 1 行
    for (const summary of summaries) {
      expect(manifest).toContain(`· ${summary.name} — ${summary.description}`)
    }
    // 抬头点明「正文不在此展示」（TK4：正文只能经 skill_read）。
    expect(manifest.split('\n')[0]).toContain('skill_read')
  })

  it('清单按 name 字节序排序，且两次调用逐字相同（稳定前缀的字节稳定契约）', () => {
    const names = buildSkillManifestText()
      .split('\n')
      .slice(1)
      .map((line) => line.slice(2).split(' — ')[0])

    expect(names).toEqual([...names].sort())
    // 与注册顺序无关：注册表里 planning 在最前，排序后不再是。
    expect(names).toEqual([
      'ask-user-question',
      'data-visualization',
      'planning',
      'tool-loading',
      'web-chat-agent',
    ])
    expect(buildSkillManifestText()).toBe(buildSkillManifestText())
  })

  it('description 写成触发条件式（何时用/何时不用），且控制在清单 token 预算内', () => {
    for (const summary of listSkillSummaries()) {
      expect(summary.description).toContain('何时用')
      expect(summary.description).toContain('何时不用')
      // 蓝图「数据模型」：单条 description ≤ 160 字符。
      expect(summary.description.length).toBeLessThanOrEqual(160)
      // 清单是单行格式，description 内不能有换行。
      expect(summary.description).not.toContain('\n')
    }
  })
})
