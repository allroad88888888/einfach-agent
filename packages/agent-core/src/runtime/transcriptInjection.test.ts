import { describe, expect, it } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import { runtimeTranscriptEventsAtom } from '../state/transientAtoms'
import type { SkillsRegistry } from '../skills/contracts'
import { createCoreInstance } from './core/coreInstance'
import type { StableModelPrefix } from './modelTurnPrefix'
import { injectStablePrefixTranscript } from './transcriptInjection'

function prefix(): StableModelPrefix {
  const system = { role: 'system' as const, content: '固定 system' }
  const toolManifest = { role: 'system' as const, content: '可用工具摘要' }
  const skillManifest = { role: 'system' as const, content: '可用 skills：· planning — …' }
  const environment = { role: 'system' as const, content: '运行环境' }
  const items = [system, toolManifest, skillManifest, environment]
  return {
    items,
    content: items.map((item) => item.content).join('\n'),
    system,
    toolManifest,
    skillManifest,
    environment,
    hostHasLocalCapabilities: false,
  }
}

describe('injectStablePrefixTranscript', () => {
  it('镜像稳定前缀四段：system、运行环境、skill 清单与工具摘要各一条', () => {
    const skillsRegistry: SkillsRegistry = {
      buildManifestText: () => '不该由转录再组一次',
      list: () => [{ name: 'planning', description: '规划', triggers: [] }],
    }
    const core = createCoreInstance({ skillRegistry: skillsRegistry })
    const id = 'transcript-session'
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: '转录测试',
        settings: { vendor: 'deepseek', model: 'deepseek-v4-flash' },
        createdAt: 0,
        updatedAt: 0,
      },
    })

    injectStablePrefixTranscript(id, prefix(), core)

    const events = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
    expect(events.map((event) => event.title)).toEqual([
      '注入 system',
      '注入运行环境',
      '注入 skill 清单',
      '注入工具摘要清单',
    ])
    // 转录展示的是**已经组好**的那份清单正文（前缀里的字节），摘要只补一句「有几个内置 skill」。
    const manifestEvent = events.find((event) => event.title === '注入 skill 清单')
    expect(manifestEvent?.detail).toBe(prefix().skillManifest.content)
    expect(manifestEvent?.summary).toBe('清单含 1 个 skill：planning')
  })
})
