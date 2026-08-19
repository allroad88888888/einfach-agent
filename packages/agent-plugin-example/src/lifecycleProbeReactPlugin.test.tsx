import { render, screen } from '@testing-library/react'
import {
  createTimelineRendererRegistry,
  installReactPlugins,
} from '@einfach-agent/react-plugin'
import { describe, expect, it } from 'vitest'
import { createLifecycleProbeReactPlugin } from './react'

describe('lifecycle probe React plugin', () => {
  it('uses public renderer APIs and leaves no registration after uninstall', () => {
    const registry = createTimelineRendererRegistry()
    const dispose = installReactPlugins(registry, [createLifecycleProbeReactPlugin()])
    const Renderer = registry.resolve('reasoning')

    expect(Renderer).toBeDefined()
    if (!Renderer) throw new Error('Expected the reasoning renderer to be installed.')
    render(
      <Renderer
        item={{
          id: 'reasoning-1',
          kind: 'reasoning',
          content: 'sample reasoning',
          createdAt: 1,
          sortKey: 'sample:reasoning-1',
        }}
      />,
    )

    expect(screen.getByTestId('lifecycle-probe-reasoning')).toHaveTextContent('sample reasoning')
    dispose()
    expect(registry.resolve('reasoning')).toBeUndefined()
  })
})
