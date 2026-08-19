import type { TimelineReasoningItem } from '@einfach-agent/core/timeline'
import { describe, expect, it } from 'vitest'
import {
  createTimelineRendererRegistry,
  defineReactPlugin,
  installReactPlugins,
} from './index'

function ReasoningRenderer({ item }: { readonly item: TimelineReasoningItem }) {
  return <div>reasoning:{item.content}</div>
}

describe('React plugin lifecycle', () => {
  it('removes every renderer registration when the host uninstalls a plugin', () => {
    const registry = createTimelineRendererRegistry()
    const plugin = defineReactPlugin({
      install(api) {
        api.registerRenderer('reasoning', ReasoningRenderer)
      },
    })

    const dispose = installReactPlugins(registry, [plugin])

    expect(registry.resolve('reasoning')).toBe(ReasoningRenderer)
    dispose()
    dispose()
    expect(registry.resolve('reasoning')).toBeUndefined()
  })

  it('cleans registrations when plugin installation fails', () => {
    const registry = createTimelineRendererRegistry()
    const plugin = defineReactPlugin({
      install(api) {
        api.registerRenderer('reasoning', ReasoningRenderer)
        throw new Error('install failed')
      },
    })

    expect(() => installReactPlugins(registry, [plugin])).toThrow('install failed')
    expect(registry.resolve('reasoning')).toBeUndefined()
  })

  it('does not remove a newer renderer after its plugins were already uninstalled', () => {
    const registry = createTimelineRendererRegistry()
    const plugin = defineReactPlugin({
      install(api) {
        api.registerRenderer('reasoning', ReasoningRenderer)
      },
    })
    const dispose = installReactPlugins(registry, [plugin])

    dispose()
    const disposeNewRenderer = registry.register('reasoning', ReasoningRenderer)
    dispose()

    expect(registry.resolve('reasoning')).toBe(ReasoningRenderer)
    disposeNewRenderer()
  })

  it('releases renderers even when a plugin disposer fails', () => {
    const registry = createTimelineRendererRegistry()
    const plugin = defineReactPlugin({
      install(api) {
        api.registerRenderer('reasoning', ReasoningRenderer)
        return () => {
          throw new Error('plugin cleanup failed')
        }
      },
    })
    const dispose = installReactPlugins(registry, [plugin])

    expect(dispose).toThrow('plugin cleanup failed')
    expect(registry.resolve('reasoning')).toBeUndefined()
  })
})
