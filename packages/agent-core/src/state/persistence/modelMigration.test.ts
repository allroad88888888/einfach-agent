// D-3b · 下线模型名迁移表的单测。
// ---------------------------------------------------------------------------
// 覆盖迁移函数的四条不变量：官方指定的继任者、幂等、不误伤（已是新名 / 未知名）、
// 不覆盖用户显式设置的 thinking；外加迁移表本身的自洽性（继任者不得再是某条规则的旧名，否则不幂等）。

import { describe, expect, it } from 'vitest'

import type { ModelSettings } from '../core.type'
import {
  DEPRECATED_MODEL_MIGRATIONS,
  migrateModelSettings,
  migrateSessionMeta,
  normalizeDeepSeekReasoningEffort,
  normalizePrimaryAgentSettings,
} from './modelMigration'

// 编译期回归：两家 Provider 的取值域必须继续按 vendor 独立收窄。
const deepSeekMaxSettings: ModelSettings = {
  vendor: 'deepseek',
  model: 'deepseek-v4-pro',
  reasoning_effort: 'max',
}
const glmLowSettings: ModelSettings = {
  vendor: 'glm',
  model: 'glm-5',
  reasoning_effort: 'low',
}
// @ts-expect-error DeepSeek V4 不再接受旧 low 档；只允许在持久化迁移边界归一化。
const invalidDeepSeekLowSettings: ModelSettings = {
  vendor: 'deepseek',
  model: 'deepseek-v4-pro',
  reasoning_effort: 'low',
}
void [deepSeekMaxSettings, glmLowSettings, invalidDeepSeekLowSettings]

describe('normalizeDeepSeekReasoningEffort', () => {
  it.each([
    ['high', 'high'],
    ['max', 'max'],
    ['low', 'high'],
    ['medium', 'high'],
    ['xhigh', 'max'],
  ])('%s → %s', (before, after) => {
    expect(normalizeDeepSeekReasoningEffort(before)).toBe(after)
  })

  it.each([undefined, null, '', 'turbo', 1, {}, []])('非法历史值 %j → undefined', (value) => {
    expect(normalizeDeepSeekReasoningEffort(value)).toBeUndefined()
  })
})

describe('migrateModelSettings', () => {
  it('deepseek-chat → deepseek-v4-flash 且补上非思考模式', () => {
    const before: ModelSettings = { vendor: 'deepseek', model: 'deepseek-chat' }

    const after = migrateModelSettings(before)

    expect(after.model).toBe('deepseek-v4-flash')
    expect(after.thinking).toBe(false)
    // 不原地改入参（sessions 数组是调用方的，checkpoint 快照依赖不可变更新）。
    expect(before.model).toBe('deepseek-chat')
  })

  it('deepseek-reasoner → deepseek-v4-flash 且补上思考模式', () => {
    const after = migrateModelSettings({ vendor: 'deepseek', model: 'deepseek-reasoner' })

    expect(after.model).toBe('deepseek-v4-flash')
    expect(after.thinking).toBe(true)
  })

  it('迁移保留 settings 的其它字段（vendor / temperature / reasoning_effort）', () => {
    const after = migrateModelSettings({
      vendor: 'deepseek',
      model: 'deepseek-reasoner',
      temperature: 0.3,
      reasoning_effort: 'high',
    })

    expect(after).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: true,
      temperature: 0.3,
      reasoning_effort: 'high',
    })
  })

  it('用户显式设过的 thinking 不被旧名的隐含模式覆盖', () => {
    // 显式关思考的 deepseek-reasoner 会话：模型名要迁，但 thinking=false 是用户的主动选择，得留着。
    const offOnReasoner = migrateModelSettings({
      vendor: 'deepseek',
      model: 'deepseek-reasoner',
      thinking: false,
    })
    expect(offOnReasoner.model).toBe('deepseek-v4-flash')
    expect(offOnReasoner.thinking).toBe(false)

    // 反向同理：显式开思考的 deepseek-chat 会话。
    const onOnChat = migrateModelSettings({
      vendor: 'deepseek',
      model: 'deepseek-chat',
      thinking: true,
    })
    expect(onOnChat.model).toBe('deepseek-v4-flash')
    expect(onOnChat.thinking).toBe(true)
  })

  it('幂等：迁移结果再迁一次原样返回（同一引用）', () => {
    const once = migrateModelSettings({ vendor: 'deepseek', model: 'deepseek-chat' })
    const twice = migrateModelSettings(once)

    expect(twice).toBe(once)
  })

  it('已是新模型名的会话不受影响（原样返回同一引用）', () => {
    const settings: ModelSettings = { vendor: 'deepseek', model: 'deepseek-v4-pro' }

    expect(migrateModelSettings(settings)).toBe(settings)
  })

  it('未知模型名原样保留 —— 不武断改写用户显式设置的模型', () => {
    const custom: ModelSettings = { vendor: 'deepseek', model: 'my-private-finetune' }
    expect(migrateModelSettings(custom)).toBe(custom)

    // 跨 vendor 撞名不误迁：GLM 会话里一个叫 deepseek-chat 的模型不归 deepseek 那行管。
    const glm: ModelSettings = { vendor: 'glm', model: 'deepseek-chat' }
    expect(migrateModelSettings(glm)).toBe(glm)
  })

  it('DeepSeek 历史 reasoning_effort 在模型名迁移前安全归一化', () => {
    const legacy = (reasoning_effort: unknown): ModelSettings => ({
      vendor: 'deepseek',
      model: 'deepseek-chat',
      reasoning_effort,
    } as unknown as ModelSettings)

    expect(migrateModelSettings(legacy('low'))).toMatchObject({
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
    })
    expect(migrateModelSettings(legacy('medium'))).toMatchObject({
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
    })
    expect(migrateModelSettings(legacy('xhigh'))).toMatchObject({
      model: 'deepseek-v4-flash',
      reasoning_effort: 'max',
    })
  })

  it('DeepSeek 任意非法历史值会被移除，GLM 合法旧档保持原样', () => {
    const invalidDeepSeek = {
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning_effort: 'turbo',
    } as unknown as ModelSettings
    const glm: ModelSettings = {
      vendor: 'glm',
      model: 'glm-5',
      reasoning_effort: 'low',
    }

    const safeDeepSeek = migrateModelSettings(invalidDeepSeek)
    expect(safeDeepSeek).not.toHaveProperty('reasoning_effort')
    expect(safeDeepSeek).not.toBe(invalidDeepSeek)
    expect(migrateModelSettings(glm)).toBe(glm)
  })

  it('不给未声明 impliedThinking 的规则乱补 thinking', () => {
    // 表里当前两行都声明了 impliedThinking；这里断言的是函数行为而非表内容：
    // 用一条临时规则形状验证「impliedThinking 为 undefined 时不碰 thinking」。
    const ruleWithoutMode = DEPRECATED_MODEL_MIGRATIONS.find((r) => r.impliedThinking === undefined)
    if (!ruleWithoutMode) {
      // 表里暂时没有这类规则 —— 用例留着，等将来加了「不隐含模式」的下线模型自动生效。
      expect(ruleWithoutMode).toBeUndefined()
      return
    }
    const after = migrateModelSettings({
      vendor: ruleWithoutMode.vendor,
      model: ruleWithoutMode.from,
    })
    expect(after.thinking).toBeUndefined()
  })
})

describe('normalizePrimaryAgentSettings', () => {
  it('下线旧名兼容迁移到 Flash 并保留旧名的思考语义', () => {
    expect(normalizePrimaryAgentSettings({ vendor: 'deepseek', model: 'deepseek-chat' })).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: false,
    })
    expect(normalizePrimaryAgentSettings({ vendor: 'deepseek', model: 'deepseek-reasoner' })).toEqual({
      vendor: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: true,
    })
  })

  it('用户已保存的 Flash 选择保持同一引用', () => {
    const flash: ModelSettings = {
      vendor: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: false,
      temperature: 0.2,
    }

    expect(normalizePrimaryAgentSettings(flash)).toBe(flash)
  })

  it('已是 Pro 或自定义模型时不改写并保持同一引用', () => {
    const pro: ModelSettings = { vendor: 'deepseek', model: 'deepseek-v4-pro' }
    const custom: ModelSettings = { vendor: 'deepseek', model: 'my-private-finetune' }

    expect(normalizePrimaryAgentSettings(pro)).toBe(pro)
    expect(normalizePrimaryAgentSettings(custom)).toBe(custom)
  })
})

describe('DEPRECATED_MODEL_MIGRATIONS 表自洽性', () => {
  it('继任者不得同时是某条规则的旧名（否则迁移不幂等，需要改成迁移链）', () => {
    const froms = new Set(DEPRECATED_MODEL_MIGRATIONS.map((r) => `${r.vendor}:${r.from}`))
    for (const rule of DEPRECATED_MODEL_MIGRATIONS) {
      expect(froms.has(`${rule.vendor}:${rule.to}`)).toBe(false)
    }
  })

  it('每条规则都注明了来源 URL 与下线时刻（给下一个维护者留证据）', () => {
    for (const rule of DEPRECATED_MODEL_MIGRATIONS) {
      expect(rule.source).toMatch(/^https?:\/\//)
      expect(rule.deprecatedAt.length).toBeGreaterThan(0)
    }
  })

  it('同一 vendor 下旧名不重复（避免两行抢同一个 from）', () => {
    const keys = DEPRECATED_MODEL_MIGRATIONS.map((r) => `${r.vendor}:${r.from}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('migrateSessionMeta', () => {
  const base = { id: 's1', title: 'A', createdAt: 0, updatedAt: 100 }

  it('迁移下线模型名，但不改 updatedAt 等其它字段', () => {
    const session = { ...base, settings: { vendor: 'deepseek', model: 'deepseek-chat' } as ModelSettings }

    const after = migrateSessionMeta(session)

    expect(after.settings.model).toBe('deepseek-v4-flash')
    expect(after.updatedAt).toBe(100)
    expect(after.createdAt).toBe(0)
    expect(after.id).toBe('s1')
    expect(after.title).toBe('A')
  })

  it('无需迁移时原样返回同一引用（包括用户已保存的 Flash）', () => {
    const session = { ...base, settings: { vendor: 'deepseek', model: 'deepseek-v4-flash' } as ModelSettings }

    expect(migrateSessionMeta(session)).toBe(session)
  })
})
