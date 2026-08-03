import { render } from '@testing-library/react'
import type { TimelineRendererRegistry } from '@web-agent/react-plugin'
import { describe, expect, it } from 'vitest'
import {
  useWebTimelineRendererRegistry,
  WebTimelineRendererRegistryProvider,
} from './WebTimelineRendererRegistryProvider'

function RegistryProbe({ onRegistry }: { readonly onRegistry: (registry: TimelineRendererRegistry) => void }) {
  onRegistry(useWebTimelineRendererRegistry())
  return null
}

describe('WebTimelineRendererRegistryProvider', () => {
  it('keeps one registry for a root and creates another for a separate root', () => {
    const firstRootRegistries: TimelineRendererRegistry[] = []
    const firstRoot = render(
      <WebTimelineRendererRegistryProvider>
        <RegistryProbe onRegistry={(registry) => firstRootRegistries.push(registry)} />
      </WebTimelineRendererRegistryProvider>,
    )

    firstRoot.rerender(
      <WebTimelineRendererRegistryProvider>
        <RegistryProbe onRegistry={(registry) => firstRootRegistries.push(registry)} />
      </WebTimelineRendererRegistryProvider>,
    )

    const secondRootRegistries: TimelineRendererRegistry[] = []
    render(
      <WebTimelineRendererRegistryProvider>
        <RegistryProbe onRegistry={(registry) => secondRootRegistries.push(registry)} />
      </WebTimelineRendererRegistryProvider>,
    )

    expect(firstRootRegistries[0]).toBe(firstRootRegistries[1])
    expect(secondRootRegistries[0]).not.toBe(firstRootRegistries[0])
    expect(firstRootRegistries[0].resolve('message')).toBeDefined()
  })
})
