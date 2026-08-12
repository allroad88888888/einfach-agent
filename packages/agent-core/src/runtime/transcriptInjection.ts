import type { ModelFunctionTool } from '@web-agent/ai'
import {
  addRuntimeTranscriptEvent,
  getTranscriptInjectionFingerprints,
  patchTranscriptInjectionFingerprints,
} from '../state/transientAtoms'
import type { CoreInstance } from './core/coreInstance'
import { fnv1a32 } from './shared/hash'
import { newId } from './newId'
import type { StableModelPrefix } from './modelTurnPrefix'

function compactText(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact
}

function transcriptDetail(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function addInjectionEvent(
  sessionId: string,
  kind: 'system_injection' | 'tool_manifest',
  title: string,
  summary: string,
  detail: unknown,
  core: CoreInstance,
): void {
  addRuntimeTranscriptEvent(sessionId, {
    id: newId(),
    createdAt: Date.now(),
    kind,
    title,
    summary,
    detail: transcriptDetail(detail),
  }, core)
}

/**
 * Mirrors stable request items into the UI transcript once per changed content.
 * Fingerprints are transient, so a fresh UI transcript always gets its first set.
 */
export function injectStablePrefixTranscript(
  sessionId: string,
  prefix: StableModelPrefix,
  core: CoreInstance,
): void {
  const fingerprints = getTranscriptInjectionFingerprints(sessionId, core)
  const earlyEntries = [
    ['system', '注入 system', compactText(prefix.system.content), prefix.system.content],
    ['environment', '注入运行环境', compactText(prefix.environment.content), prefix.environment.content],
  ] as const

  for (const [key, title, summary, detail] of earlyEntries) {
    const fingerprint = fnv1a32(detail)
    if (fingerprints[key] === fingerprint) continue
    addInjectionEvent(sessionId, 'system_injection', title, summary, detail, core)
    patchTranscriptInjectionFingerprints(sessionId, { [key]: fingerprint }, core)
  }

  if (prefix.customInstructions) {
    const fingerprint = fnv1a32(prefix.customInstructions.content)
    if (fingerprints.customInstructions !== fingerprint) {
      const title = fingerprints.customInstructions == null ? '注入自定义指令' : '自定义指令已更新'
      addInjectionEvent(
        sessionId,
        'system_injection',
        title,
        compactText(prefix.customInstructions.content),
        prefix.customInstructions.content,
        core,
      )
      patchTranscriptInjectionFingerprints(sessionId, { customInstructions: fingerprint }, core)
    }
  } else if (fingerprints.customInstructions != null) {
    addInjectionEvent(sessionId, 'system_injection', '自定义指令已清除', '用户已清空自定义指令', '', core)
    patchTranscriptInjectionFingerprints(sessionId, { customInstructions: null }, core)
  }

  const manifestEntries = [
    ['toolManifest', '注入工具摘要清单', compactText(prefix.toolManifest.content), prefix.toolManifest.content],
  ] as const
  for (const [key, title, summary, detail] of manifestEntries) {
    const fingerprint = fnv1a32(detail)
    if (fingerprints[key] === fingerprint) continue
    addInjectionEvent(sessionId, 'system_injection', title, summary, detail, core)
    patchTranscriptInjectionFingerprints(sessionId, { [key]: fingerprint }, core)
  }
}

function toolManifestSummary(tools: ModelFunctionTool[], previousCount?: number): string {
  const countLabel = previousCount !== undefined && previousCount !== tools.length
    ? `${previousCount} → ${tools.length}`
    : `${tools.length}`
  return compactText(`暴露 ${countLabel} 个工具：${tools.map((tool) => tool.function.name).join('、') || '无'}`)
}

/** Records the turn-level tool projection only when the schema set really changed. */
export function injectToolTranscript(
  sessionId: string,
  tools: ModelFunctionTool[],
  fingerprint: string,
  core: CoreInstance,
): void {
  const prior = getTranscriptInjectionFingerprints(sessionId, core)
  if (prior.toolsFingerprint === fingerprint) return
  const first = prior.toolsFingerprint === undefined
  addInjectionEvent(
    sessionId,
    'tool_manifest',
    first ? '注入 tools' : '工具集已更新',
    toolManifestSummary(tools, first ? undefined : prior.toolsCount),
    tools,
    core,
  )
  patchTranscriptInjectionFingerprints(sessionId, { toolsFingerprint: fingerprint, toolsCount: tools.length }, core)
}
