// 每个 React root 独有的 timeline renderer 注册表；只存组件，不承载状态或命令。

import type {
  TimelineItemKind,
  TimelineRenderer,
  TimelineRendererRegistry,
  TimelineRendererRegistryOptions,
} from './timelineRendererTypes'

interface RendererRegistration {
  readonly renderer: unknown
}

function lockBuiltInRenderers(
  registrations: Map<string, RendererRegistration>,
  lockedKinds: Set<string>,
  builtInRenderers: TimelineRendererRegistryOptions['builtInRenderers'],
): void {
  if (!builtInRenderers) return
  for (const [kind, renderer] of Object.entries(builtInRenderers)) {
    registrations.set(kind, { renderer })
    lockedKinds.add(kind)
  }
}

/** 创建 root 作用域的 renderer registry；每次调用都拥有独立注册表。 */
export function createTimelineRendererRegistry(
  options: TimelineRendererRegistryOptions = {},
): TimelineRendererRegistry {
  const registrations = new Map<string, RendererRegistration>()
  const lockedKinds = new Set<string>()
  lockBuiltInRenderers(registrations, lockedKinds, options.builtInRenderers)

  function resolve<K extends TimelineItemKind>(kind: K): TimelineRenderer<K> | undefined
  function resolve(kind: string): TimelineRenderer | undefined
  function resolve(kind: string): TimelineRenderer | undefined {
    const registration = registrations.get(kind)
    return registration?.renderer as TimelineRenderer | undefined
  }

  return {
    register<K extends TimelineItemKind>(kind: K, renderer: TimelineRenderer<K>): () => void {
      if (lockedKinds.has(kind)) {
        throw new Error(`Timeline renderer kind is locked: ${kind}`)
      }
      if (registrations.has(kind)) {
        throw new Error(`Timeline renderer already registered: ${kind}`)
      }

      const registration: RendererRegistration = { renderer }
      registrations.set(kind, registration)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        if (registrations.get(kind) === registration) registrations.delete(kind)
      }
    },
    resolve,
  }
}
