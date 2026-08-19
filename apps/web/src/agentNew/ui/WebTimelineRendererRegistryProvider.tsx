// 在一个 Web React root 内创建并共享 timeline renderer registry。

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import type { TimelineRendererRegistry } from '@einfach-agent/react-plugin'
import { createWebTimelineRendererRegistry } from './webTimelineRendererRegistry'

const timelineRendererRegistryContext = createContext<TimelineRendererRegistry | null>(null)

export function WebTimelineRendererRegistryProvider({ children }: { readonly children: ReactNode }) {
  const [registry] = useState(createWebTimelineRendererRegistry)

  return (
    <timelineRendererRegistryContext.Provider value={registry}>
      {children}
    </timelineRendererRegistryContext.Provider>
  )
}

export function useWebTimelineRendererRegistry(): TimelineRendererRegistry {
  const registry = useContext(timelineRendererRegistryContext)
  if (!registry) {
    throw new Error('WebTimelineRendererRegistryProvider is required for timeline rendering.')
  }
  return registry
}
