import { describe, expect, it, vi } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import { runtimeTranscriptEventsAtom } from '../state/transientAtoms'
import type { SkillsRegistry } from '../skills/contracts'
import { createCoreInstance } from './core/coreInstance'
import type { StableModelPrefix } from './modelTurnPrefix'
import { injectStablePrefixTranscript } from './transcriptInjection'

function prefix(): StableModelPrefix {
  const system = { role: 'system' as const, content: '固定 system' }
  const toolManifest = { role: 'system' as const, content: '可用工具摘要' }
  const environment = { role: 'system' as const, content: '运行环境' }
  const items = [system, toolManifest, environment]
  return {
    items,
    content: items.map((item) => item.content).join('\n'),
    system,
    toolManifest,
    environment,
    isTauri: false,
  }
}

describe('injectStablePrefixTranscript', () => {
  it('只镜像稳定 system、工具摘要和运行环境，不再把 skills 记为 stable system 注入', () => {
    const buildManifestText = vi.fn(() => '可用 skills：不应被读取')
    const skillsRegistry: SkillsRegistry = { buildManifestText, list: () => [] }
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
      '注入工具摘要清单',
    ])
    expect(events.every((event) => !event.title.includes('skill'))).toBe(true)
    expect(buildManifestText).not.toHaveBeenCalled()
  })
})
